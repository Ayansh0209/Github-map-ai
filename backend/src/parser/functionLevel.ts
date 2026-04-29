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
    // arrow functions need a variable declaration parent to get a name
    // const foo = () => {}  →  name = "foo"
    const parent = node.getParent();

    let name: string | undefined;

    if (parent?.getKind() === SyntaxKind.VariableDeclaration) {
        const varName = (parent as any).getName?.();
        if (typeof varName === "string") name = varName;
    }

    // property assignment: const obj = { foo: () => {} }
    if (parent?.getKind() === SyntaxKind.PropertyAssignment) {
        const propName = (parent as any).getName?.();
        if (typeof propName === "string") name = propName;
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

    return functions;
}