// src/search/searchIndexer.ts
// ─────────────────────────────────────────────────────────────────────────────
// Builds a lightweight, dependency-free search index from the GraphData.
//
// Index entries are pre-tokenized during build time so that query-time
// lookups are O(n) string comparisons with no runtime tokenization overhead.
//
// The index covers:
//   - Files (by path, name, language, kind)
//   - Functions (by name, kind)
//   - Exports (exported functions)
//   - Tests (test suites and cases)
//
// The resulting SearchIndex is serializable to JSON and can be persisted
// in Redis alongside the graph cache for instant retrieval.
// ─────────────────────────────────────────────────────────────────────────────

import type {
    FileNode,
    FunctionNode,
    SearchIndex,
    SearchIndexEntry,
    ImportEdge,
} from "../models/schema";

// ── Tokenizer ─────────────────────────────────────────────────────────────────

/**
 * Split a string into search tokens.
 * Handles camelCase, PascalCase, snake_case, kebab-case, and path separators.
 * All tokens are lowercased for case-insensitive matching.
 */
function tokenize(input: string): string[] {
    const tokens = new Set<string>();

    // Add the full string lowercased
    tokens.add(input.toLowerCase());

    // Split on common separators: /, \, -, _, .
    const parts = input.split(/[/\\._\-]+/);
    for (const part of parts) {
        if (part.length === 0) continue;
        tokens.add(part.toLowerCase());

        // Split camelCase / PascalCase
        const camelParts = part.replace(/([a-z])([A-Z])/g, "$1 $2").split(/\s+/);
        for (const cp of camelParts) {
            if (cp.length > 1) tokens.add(cp.toLowerCase());
        }
    }

    return [...tokens];
}

// ── Index builder ─────────────────────────────────────────────────────────────

/**
 * Build a search index from file nodes and their functions.
 * The index is fully serializable (no Maps, no circular references).
 */
export function buildSearchIndex(
    fileNodes: FileNode[],
    allFunctions: FunctionNode[],
    importEdges: ImportEdge[],
): SearchIndex {
    const entries: SearchIndexEntry[] = [];

    // Pre-calculate file in-degree for usageCount
    const inDegree = new Map<string, number>();
    for (const edge of importEdges) {
        inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    }

    // ── Index all files ───────────────────────────────────────────────────────
    for (const file of fileNodes) {
        const tokens = [
            ...tokenize(file.id),
            ...tokenize(file.label),
            file.language,
            file.kind,
        ];

        if (file.isEntryPoint) tokens.push("entry", "entrypoint");
        if (file.isDeadCode)   tokens.push("dead", "deadcode", "unused");
        if (file.workspacePackage) {
            tokens.push(...tokenize(file.workspacePackage));
        }
        
        // Framework hints based on path
        const lowerId = file.id.toLowerCase();
        if (lowerId.includes("route")) tokens.push("route");
        if (lowerId.includes("middleware")) tokens.push("middleware");
        if (lowerId.includes("service")) tokens.push("service");
        if (lowerId.includes("controller")) tokens.push("controller");
        if (lowerId.includes("auth")) tokens.push("auth");
        if (lowerId.includes("hook") || lowerId.includes("use")) tokens.push("hook");
        if (lowerId.includes("store") || lowerId.includes("slice") || lowerId.includes("reducer")) tokens.push("state", "reducer", "store");

        entries.push({
            id: file.id,
            type: file.kind === "test" ? "test" : "file",
            name: file.label,
            filePath: file.id,
            language: file.language,
            kind: file.kind,
            isEntryPoint: file.isEntryPoint,
            isDeadCode: file.isDeadCode ?? false,
            packageName: file.workspacePackage,
            tokens: [...new Set(tokens)],
            usageCount: inDegree.get(file.id) ?? 0,
            hubScore: file.hubScore ?? 0,
        });
    }

    // ── Index exported functions ───────────────────────────────────────────────
    for (const fn of allFunctions) {
        if (!fn.isExported) continue; // only index exports for search

        const tokens = [
            ...tokenize(fn.name),
            ...tokenize(fn.filePath),
            fn.kind,
        ];

        if (fn.isAsync) tokens.push("async");

        entries.push({
            id: fn.id,
            type: "export",
            name: fn.name,
            filePath: fn.filePath,
            kind: fn.kind,
            tokens: [...new Set(tokens)],
            usageCount: fn.calledBy.length,
        });
    }

    // ── Index test suites/cases ───────────────────────────────────────────────
    for (const file of fileNodes) {
        if (file.kind !== "test") continue;

        for (const suite of file.testSuites ?? []) {
            entries.push({
                id: `${file.id}::suite::${suite}`,
                type: "test",
                name: suite,
                filePath: file.id,
                kind: "test-suite",
                tokens: [...tokenize(suite), "test", "suite", "describe"],
            });
        }

        for (const tc of file.testCases ?? []) {
            entries.push({
                id: `${file.id}::case::${tc}`,
                type: "test",
                name: tc,
                filePath: file.id,
                kind: "test-case",
                tokens: [...tokenize(tc), "test", "case", "it"],
            });
        }
    }

    console.log(
        `[searchIndexer] built index with ${entries.length} entries ` +
        `(${fileNodes.length} files, ${allFunctions.filter(f => f.isExported).length} exports)`
    );

    return {
        entries,
        generatedAt: new Date().toISOString(),
    };
}
