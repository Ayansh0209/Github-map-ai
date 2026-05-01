
// Extracts all imports and exports from a single TS/JS source file
// Uses ts-morph AST — never regex

import path from "path";
import {
    SourceFile,
    SyntaxKind,
    Node,
} from "ts-morph";
import { ImportEdge, Language } from "../models/schema";

export interface FileLevelResult {
    relativePath: string;
    language: Language;
    rawImports: RawImport[];       // before resolution
    externalImports: string[];     // node_modules imports (best-effort, resolver confirms)
    unresolvedImports: string[];   // relative imports that couldn't be resolved on disk

    // ── Phase 1: semantic signals for entry point scoring ─────────────────────
    // Detected via AST call expression scan — no cost beyond existing traversal
    hasStartupSignals: boolean;    // app.listen(), createServer(), http.listen()
    hasRouteHandlers: boolean;     // app.get/post/use(), router.get/post/put/delete/use()
}

export interface RawImport {
    specifier: string;             // raw string e.g. "./utils" or "react"
    kind: "static" | "dynamic" | "re-export";
    symbols: string[];
    isTypeOnly: boolean;           // true for: import type { Foo } from '...'
}

// ── Language detection ──────────────────────────────────────────────────────

function detectLanguage(relativePath: string): Language {
    const ext = path.extname(relativePath).toLowerCase();
    if (ext === ".ts" || ext === ".tsx") return "typescript";
    if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
    return "unknown";
}

// ── Symbol extraction helpers ───────────────────────────────────────────────

function extractImportSymbols(node: Node): string[] {
    const symbols: string[] = [];

    // named imports: import { foo, bar } from '...'
    node.getDescendantsOfKind(SyntaxKind.ImportSpecifier).forEach((s) => {
        symbols.push(s.getName());
    });

    // default import: import foo from '...'
    node.getDescendantsOfKind(SyntaxKind.ImportClause).forEach((clause) => {
        const defaultId = clause.getDefaultImport();
        if (defaultId) symbols.push(defaultId.getText());
    });

    // namespace import: import * as foo from '...'
    node.getDescendantsOfKind(SyntaxKind.NamespaceImport).forEach((ns) => {
        symbols.push(`* as ${ns.getName()}`);
    });

    return [...new Set(symbols)]; // deduplicate
}

// ── Main extractor ──────────────────────────────────────────────────────────

export function extractFileLevel(
    sourceFile: SourceFile,
    relativePath: string
): FileLevelResult {
    const rawImports: RawImport[] = [];
    const externalImports: string[] = [];
    const language = detectLanguage(relativePath);

    // 1. Static imports: import { x } from './path'
    for (const decl of sourceFile.getImportDeclarations()) {
        const specifier = decl.getModuleSpecifierValue();
        const symbols = extractImportSymbols(decl);

        rawImports.push({
            specifier,
            kind: "static",
            symbols,
            isTypeOnly: decl.isTypeOnly(),
        });
    }

    // 2. Re-exports: export { x } from './path'
    //               export * from './path'
    for (const decl of sourceFile.getExportDeclarations()) {
        const specifierNode = decl.getModuleSpecifier();
        if (!specifierNode) continue; // export { x } without from — skip

        const specifier = decl.getModuleSpecifierValue()!;
        const symbols: string[] = [];

        decl.getNamedExports().forEach((s) => {
            symbols.push(s.getName());
        });

        if (decl.isNamespaceExport()) symbols.push("*");

        rawImports.push({
            specifier,
            kind: "re-export",
            symbols,
            isTypeOnly: decl.isTypeOnly(),
        });
    }

    // 3. Dynamic imports: import('./path') and require('./path')
    sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((call) => {
        const expr = call.getExpression();
        const args = call.getArguments();

        if (args.length === 0) return;

        const firstArg = args[0];

        // import('./something')
        if (call.getKind() === SyntaxKind.CallExpression) {
            const exprText = expr.getText();

            const isImport = expr.getKind() === SyntaxKind.ImportKeyword ||
                exprText === "import";
            const isRequire = exprText === "require";

            if (!isImport && !isRequire) return;

            // only handle string literal specifiers — skip dynamic variables
            if (firstArg.getKind() !== SyntaxKind.StringLiteral) return;

            const specifier = firstArg.getText().replace(/['"]/g, "");

            rawImports.push({
                specifier,
                kind: "dynamic",
                symbols: [],
                isTypeOnly: false,
            });
        }
    });

    // Startup and route handler signals — single pass over call expressions.
    // We scan here (alongside import extraction) to avoid a redundant traversal.
    let hasStartupSignals = false;
    let hasRouteHandlers  = false;

    // Identifiers that indicate a server is being started
    const STARTUP_METHODS = new Set([
        "listen",        // app.listen(), server.listen()
        "createServer",  // http.createServer(), https.createServer()
        "start",         // fastify.start(), server.start()
        "bootstrap",     // NestJS bootstrap(AppModule)
    ]);

    // Identifiers that indicate HTTP route registration
    const ROUTE_METHODS = new Set([
        "get", "post", "put", "patch", "delete",
        "head", "options", "all",
        "use",           // middleware: app.use(), router.use()
        "route",         // Express chained routing: router.route('/path')
        "handle",        // some frameworks use router.handle()
    ]);

    sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((call) => {
        const expr = call.getExpression();

        // PropertyAccessExpression: obj.method()
        if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
            const methodName = expr.getLastChild()?.getText() ?? "";

            if (STARTUP_METHODS.has(methodName)) hasStartupSignals = true;
            if (ROUTE_METHODS.has(methodName))   hasRouteHandlers  = true;
        }

        // Direct call: createServer() — no dot notation
        const directName = expr.getText();
        if (STARTUP_METHODS.has(directName)) hasStartupSignals = true;
    });

    // Pass ALL rawImports to chunkProcessor — resolver decides internal vs external.
    // The externalImports list here is a best-effort hint (no alias resolution yet).
    const externalHints = rawImports
        .filter((imp) => !imp.specifier.startsWith(".") && !imp.specifier.startsWith("/"))
        .map((imp) => imp.specifier);

    return {
        relativePath,
        language,
        rawImports,                             // ALL imports — resolver classifies
        externalImports: [...new Set(externalHints)],
        unresolvedImports: [],                  // filled after resolver runs
        hasStartupSignals,
        hasRouteHandlers,
    };
}