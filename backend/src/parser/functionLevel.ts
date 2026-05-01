// Extracts all functions and call relationships from a single source file
// Only runs on files < 500KB (mode: "full")

import {
    SourceFile,
    SyntaxKind,
    Node,
    FunctionDeclaration,
    ArrowFunction,
    FunctionExpression,
    MethodDeclaration,
} from "ts-morph";
import { FunctionNode, Visibility, FunctionKind } from "../models/schema";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeFunctionId(relativePath: string, functionName: string): string {
    return `${relativePath}::${functionName}`;
}

function isExported(node: Node): boolean {
    return node
        .getDescendantsOfKind(SyntaxKind.ExportKeyword)
        .length > 0 ||
        node.getFirstAncestorByKind(SyntaxKind.ExportDeclaration) !== undefined;
}

// ── Call expression extraction ───────────────────────────────────────────────
// Finds all function calls made inside a given node's body
// Returns raw call names — resolved to IDs by chunkProcessor

function extractCallNames(node: Node): string[] {
    const calls = new Set<string>();

    node.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((call) => {
        const expr = call.getExpression();
        const text = expr.getText().trim();

        // skip empty or overly complex expressions
        if (!text || text.length > 100) return;

        // skip built-ins that aren't user functions
        const SKIP_CALLS = new Set([
            "console.log", "console.error", "console.warn", "console.info",
            "JSON.parse", "JSON.stringify",
            "Object.keys", "Object.values", "Object.entries", "Object.assign",
            "Array.from", "Array.isArray",
            "Math.floor", "Math.ceil", "Math.round", "Math.max", "Math.min",
            "parseInt", "parseFloat", "isNaN", "isFinite",
            "setTimeout", "setInterval", "clearTimeout", "clearInterval",
            "Promise.all", "Promise.race", "Promise.resolve", "Promise.reject",
        ]);

        if (SKIP_CALLS.has(text)) return;

        // get the base call name:
        // foo()           → "foo"
        // utils.foo()     → "foo"
        // this.foo()      → "foo"
        // obj.a.b.foo()   → "foo"
        const parts = text.split(".");
        const baseName = parts[parts.length - 1];

        // skip if it looks like a constructor or built-in
        if (!baseName || /^[A-Z]/.test(baseName)) return;

        calls.add(baseName);
    });

    return [...calls];
}

// ── Function extractors ──────────────────────────────────────────────────────

function determineFunctionKind(
    node: Node,
    name: string,
    defaultKind: FunctionKind
): FunctionKind {
    // Priority 1: constructor
    if (node.getKind() === SyntaxKind.Constructor) return "constructor";

    // Priority 2: getter
    if (node.getKind() === SyntaxKind.GetAccessor) return "getter";

    // Priority 3: setter
    if (node.getKind() === SyntaxKind.SetAccessor) return "setter";

    // Priority 4: test
    if (name.startsWith("describe(") || name.startsWith("it(") || name.startsWith("test(") || 
        name.startsWith("suite(") || name.startsWith("beforeEach(") || name.startsWith("afterEach(") ||
        name.startsWith("beforeAll(") || name.startsWith("afterAll(")) {
        return "test";
    }

    // Priority 5: route-handler
    // check if it's an argument to a route registration call
    const parent = node.getParent();
    if (parent && parent.getKind() === SyntaxKind.CallExpression) {
        const callExpr = parent as any;
        const callee = callExpr.getExpression?.();
        if (callee && callee.getKind() === SyntaxKind.PropertyAccessExpression) {
            const propAccess = callee as any;
            const objText = propAccess.Expression?.getText() || propAccess.getExpression?.()?.getText() || "";
            const methodText = propAccess.Name?.getText() || propAccess.getName?.() || "";
            if (/^(app|router|server|api|route)$/i.test(objText) && /^(get|post|put|delete|patch|use|all)$/i.test(methodText)) {
                return "route-handler";
            }
        }
    }

    // Priority 6: middleware (or alternatively 2-param route handler if not caught by #5, but the instructions say apply middleware check to params)
    let params: any[] = [];
    if (
        Node.isFunctionDeclaration(node) ||
        Node.isArrowFunction(node) ||
        Node.isFunctionExpression(node) ||
        Node.isMethodDeclaration(node)
    ) {
        params = node.getParameters();
    }
    
    if (params.length === 3) {
        const p1 = params[0].getName();
        const p2 = params[1].getName();
        const p3 = params[2].getName();
        if (/^(req|request|ctx|context)$/i.test(p1) && /^(res|response)$/i.test(p2) && /^next$/i.test(p3)) {
            return "middleware";
        }
    } else if (params.length === 2) {
        const p1 = params[0].getName();
        const p2 = params[1].getName();
        if (/^(ctx|context)$/i.test(p1) && /^next$/i.test(p2)) {
            return "middleware";
        }
    }

    // Priority 7: async
    let isNodeAsync = false;
    if ((node as any).isAsync) {
        isNodeAsync = (node as any).isAsync();
    } else if ((node as any).hasModifier) {
        isNodeAsync = (node as any).hasModifier(SyntaxKind.AsyncKeyword);
    }
    if (isNodeAsync) return "async";

    // Fallbacks (method, arrow, function, unknown) are passed via defaultKind based on extraction point
    if (defaultKind === "method") return "method";
    if (defaultKind === "arrow") return "arrow";
    if (defaultKind === "function") return "function";
    return defaultKind;
}

function extractFromFunctionDeclaration(
    node: FunctionDeclaration,
    relativePath: string
): FunctionNode | null {
    const name = node.getName();
    if (!name) return null; // anonymous function declaration — skip

    return {
        id: makeFunctionId(relativePath, name),
        name,
        filePath: relativePath,
        startLine: node.getStartLineNumber(),
        endLine: node.getEndLineNumber(),
        isExported: node.isExported(),
        kind: determineFunctionKind(node, name, node.isAsync() ? "async" : "function"),
        isAsync: node.isAsync(),
        calls: extractCallNames(node),
        calledBy: [],
        analysisConfidence: "high",
    };
}

function extractFromArrowOrExpression(
    node: ArrowFunction | FunctionExpression,
    relativePath: string
): FunctionNode | null {
    // Walk up the parent chain to find a name for this function.
    // Handles: const foo = () => {}
    //          { foo: function() {} }
    //          exports.foo = () => {}
    //          module.exports.foo = function() {}
    let name: string | undefined;
    let current: Node | undefined = node.getParent();

    while (current) {
        const kind = current.getKind();

        // const foo = () => {}
        if (kind === SyntaxKind.VariableDeclaration) {
            const varName = (current as any).getName?.();
            if (typeof varName === "string") name = varName;
            break;
        }

        // { foo: () => {} } inside object literal
        if (kind === SyntaxKind.PropertyAssignment) {
            const propName = (current as any).getName?.();
            if (typeof propName === "string") name = propName;
            break;
        }

        // exports.foo = () => {} or module.exports.foo = () => {}
        if (kind === SyntaxKind.BinaryExpression) {
            const leftText = (current as any).getLeft?.()?.getText?.() ?? "";
            const match = leftText.match(/^(?:module\.)?exports\.([\w$]+)$/);
            if (match) {
                name = match[1];
                break;
            }
        }

        // Passed as argument to a CallExpression (e.g., describe("foo", () => {}), map(() => {}))
        if (kind === SyntaxKind.CallExpression) {
            const callExpr = current as any;
            const exprText = callExpr.getExpression?.()?.getText?.();
            if (exprText) {
                if (/^(it|test|describe|beforeEach|afterEach|beforeAll|afterAll)$/.test(exprText)) {
                    const args = callExpr.getArguments?.();
                    if (args && args.length > 0) {
                        const firstArg = args[0].getText().replace(/['"`]/g, "");
                        name = `${exprText}(${firstArg})`;
                    } else {
                        name = `${exprText}()`;
                    }
                }
            }
            break;
        }

        // Stop at function/block boundaries — don't walk outside the function scope
        if (
            kind === SyntaxKind.FunctionDeclaration ||
            kind === SyntaxKind.ArrowFunction ||
            kind === SyntaxKind.FunctionExpression ||
            kind === SyntaxKind.MethodDeclaration ||
            kind === SyntaxKind.SourceFile
        ) {
            break;
        }

        current = current.getParent();
    }

    if (!name) return null; // truly anonymous — skip

    return {
        id: makeFunctionId(relativePath, name),
        name,
        filePath: relativePath,
        startLine: node.getStartLineNumber(),
        endLine: node.getEndLineNumber(),
        isExported: isExported(node),
        kind: determineFunctionKind(node, name, "arrow"),
        isAsync: node.hasModifier(SyntaxKind.AsyncKeyword),
        calls: extractCallNames(node),
        calledBy: [],
        analysisConfidence: "high",
    };
}

function getVisibility(node: MethodDeclaration): Visibility {
    if (node.hasModifier(SyntaxKind.PrivateKeyword)) return "private";
    if (node.hasModifier(SyntaxKind.ProtectedKeyword)) return "protected";
    return "public";
}

function extractFromMethod(
    node: MethodDeclaration,
    relativePath: string
): FunctionNode | null {
    const name = node.getName();
    if (!name) return null;

    // prefix with class name for clarity: "MyClass.myMethod"
    const classDecl = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    const className = classDecl?.getName();
    const fullName = className ? `${className}.${name}` : name;

    return {
        id: makeFunctionId(relativePath, fullName),
        name: fullName,
        filePath: relativePath,
        startLine: node.getStartLineNumber(),
        endLine: node.getEndLineNumber(),
        isExported: isExported(node),
        kind: determineFunctionKind(node, fullName, "method"),
        isAsync: node.isAsync(),
        visibility: getVisibility(node),
        parentId: className ? `${relativePath}::${className}` : undefined,
        calls: extractCallNames(node),
        calledBy: [],
        analysisConfidence: "high",
    };
}

function extractFromAccessor(
    node: Node, // GetAccessorDeclaration | SetAccessorDeclaration
    relativePath: string,
    accessorKind: "getter" | "setter"
): FunctionNode | null {
    const nameNode = (node as any).getNameNode?.();
    const name = nameNode ? nameNode.getText() : "unknown";

    const classDecl = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    const className = classDecl?.getName();
    const fullName = className ? `${className}.${name}` : name;

    let exported = false;
    if (classDecl) {
        exported = isExported(classDecl);
    }

    return {
        id: makeFunctionId(relativePath, fullName),
        name: fullName,
        filePath: relativePath,
        startLine: node.getStartLineNumber(),
        endLine: node.getEndLineNumber(),
        isExported: exported,
        kind: accessorKind,
        isAsync: false,
        calls: extractCallNames(node),
        calledBy: [],
        analysisConfidence: "high",
    };
}

function extractFromConstructor(
    node: Node, // ConstructorDeclaration
    relativePath: string
): FunctionNode | null {
    const classDecl = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    const className = classDecl?.getName();
    const name = className ? `${className}.constructor` : "constructor";

    let exported = false;
    if (classDecl) {
        exported = isExported(classDecl);
    }

    let vis: Visibility = "public";
    if ((node as any).hasModifier) {
        if ((node as any).hasModifier(SyntaxKind.PrivateKeyword)) vis = "private";
        else if ((node as any).hasModifier(SyntaxKind.ProtectedKeyword)) vis = "protected";
    }

    return {
        id: makeFunctionId(relativePath, name),
        name,
        filePath: relativePath,
        startLine: node.getStartLineNumber(),
        endLine: node.getEndLineNumber(),
        isExported: exported,
        kind: "constructor",
        isAsync: false,
        visibility: vis,
        calls: extractCallNames(node),
        calledBy: [],
        analysisConfidence: "high",
    };
}

// ── CommonJS exports extractor ───────────────────────────────────────────────
// Handles:
//   module.exports = function foo() {}
//   module.exports = { foo: function() {} }
//   exports.foo = function() {}
//   module.exports.foo = function() {}

const EXPORTS_LEFT_RE = /^(?:module\.)?exports(?:\.([\w$]+))?$/;

function extractFromCommonJS(
    sourceFile: SourceFile,
    relativePath: string
): FunctionNode[] {
    const results: FunctionNode[] = [];

    sourceFile
        .getDescendantsOfKind(SyntaxKind.BinaryExpression)
        .forEach((binExpr) => {
            // Only handle assignment expressions
            if (binExpr.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) return;

            const leftText = binExpr.getLeft().getText().trim();
            const match = leftText.match(EXPORTS_LEFT_RE);
            if (!match) return;

            const right = binExpr.getRight();
            const rightKind = right.getKind();

            // module.exports = function foo() {} or exports.foo = function() {}
            if (
                rightKind === SyntaxKind.FunctionExpression ||
                rightKind === SyntaxKind.ArrowFunction
            ) {
                // Try to get name from: 1) function's own name, 2) left side property
                let name: string | undefined;
                if (rightKind === SyntaxKind.FunctionExpression) {
                    name = (right as FunctionExpression).getName();
                }
                if (!name) name = match[1]; // exports.foo → "foo"
                if (!name) return; // module.exports = function() {} — anonymous, skip

                results.push({
                    id: makeFunctionId(relativePath, name),
                    name,
                    filePath: relativePath,
                    startLine: right.getStartLineNumber(),
                    endLine: right.getEndLineNumber(),
                    isExported: true,
                    kind: determineFunctionKind(right, name, rightKind === SyntaxKind.ArrowFunction ? "arrow" : "function"),
                    isAsync: (right as FunctionExpression | ArrowFunction).isAsync(),
                    calls: extractCallNames(right),
                    calledBy: [],
                    analysisConfidence: "high",
                });
                return;
            }

            // module.exports = { foo: function() {}, bar: () => {} }
            if (rightKind === SyntaxKind.ObjectLiteralExpression) {
                right.getDescendantsOfKind(SyntaxKind.PropertyAssignment).forEach((prop) => {
                    const propName = prop.getName();
                    if (!propName) return;

                    const init = prop.getInitializer();
                    if (!init) return;
                    const initKind = init.getKind();

                    if (
                        initKind === SyntaxKind.FunctionExpression ||
                        initKind === SyntaxKind.ArrowFunction
                    ) {
                        results.push({
                            id: makeFunctionId(relativePath, propName),
                            name: propName,
                            filePath: relativePath,
                            startLine: init.getStartLineNumber(),
                            endLine: init.getEndLineNumber(),
                            isExported: true,
                            kind: determineFunctionKind(init, propName, initKind === SyntaxKind.ArrowFunction ? "arrow" : "function"),
                            isAsync: (init as FunctionExpression | ArrowFunction).isAsync(),
                            calls: extractCallNames(init),
                            calledBy: [],
                            analysisConfidence: "high",
                        });
                    }
                });
            }
        });

    return results;
}

// ── Main extractor ───────────────────────────────────────────────────────────

export function extractFunctionLevel(
    sourceFile: SourceFile,
    relativePath: string
): FunctionNode[] {
    const functions: FunctionNode[] = [];
    const seenIds = new Set<string>(); // deduplicate by ID

    function addIfUnique(fn: FunctionNode | null): void {
        if (!fn) return;
        if (seenIds.has(fn.id)) return;
        seenIds.add(fn.id);
        functions.push(fn);
    }

    // 1. Regular function declarations
    sourceFile
        .getDescendantsOfKind(SyntaxKind.FunctionDeclaration)
        .forEach((node) => {
            addIfUnique(extractFromFunctionDeclaration(node, relativePath));
        });

    // 2. Arrow functions
    sourceFile
        .getDescendantsOfKind(SyntaxKind.ArrowFunction)
        .forEach((node) => {
            addIfUnique(extractFromArrowOrExpression(node, relativePath));
        });

    // 3. Function expressions: const foo = function() {}
    sourceFile
        .getDescendantsOfKind(SyntaxKind.FunctionExpression)
        .forEach((node) => {
            addIfUnique(extractFromArrowOrExpression(node, relativePath));
        });

    // 4. Class methods
    sourceFile
        .getDescendantsOfKind(SyntaxKind.MethodDeclaration)
        .forEach((node) => {
            addIfUnique(extractFromMethod(node, relativePath));
        });

    // 5. CommonJS: module.exports / exports.foo patterns
    extractFromCommonJS(sourceFile, relativePath).forEach((fn) => {
        addIfUnique(fn);
    });

    // 6. Getters
    sourceFile
        .getDescendantsOfKind(SyntaxKind.GetAccessor)
        .forEach(node => addIfUnique(
            extractFromAccessor(node, relativePath, "getter")
        ));

    // 7. Setters
    sourceFile
        .getDescendantsOfKind(SyntaxKind.SetAccessor)
        .forEach(node => addIfUnique(
            extractFromAccessor(node, relativePath, "setter")
        ));

    // 8. Constructors
    sourceFile
        .getDescendantsOfKind(SyntaxKind.Constructor)
        .forEach(node => addIfUnique(
            extractFromConstructor(node, relativePath)
        ));

    return functions;
}

export function extractTestMetadata(
    sourceFile: SourceFile
): { testSuites: string[]; testCases: string[] } {
    const testSuites: string[] = [];
    const testCases: string[] = [];

    sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((callExpr) => {
        const callee = callExpr.getExpression().getText().trim();
        const args = callExpr.getArguments();
        
        if (args.length > 0 && args[0].getKind() === SyntaxKind.StringLiteral) {
            const argText = args[0].getText().replace(/^["'`]|["'`]$/g, "");
            if (/^(describe|suite)$/.test(callee)) {
                testSuites.push(argText);
            } else if (/^(it|test)$/.test(callee)) {
                testCases.push(argText);
            }
        }
    });

    return { testSuites, testCases };
}