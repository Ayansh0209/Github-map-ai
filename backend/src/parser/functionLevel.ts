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
import { FunctionNode, Visibility } from "../models/schema";

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
        kind: node.isAsync() ? "async" : "function",
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
        kind: "arrow",
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
        kind: node.isAsync() ? "async" : "method",
        visibility: getVisibility(node),
        parentId: className ? `${relativePath}::${className}` : undefined,
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
                    kind: rightKind === SyntaxKind.ArrowFunction ? "arrow" : "function",
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
                            kind: initKind === SyntaxKind.ArrowFunction ? "arrow" : "function",
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

    return functions;
}