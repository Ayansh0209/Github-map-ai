// src/parser/retrievalBuilder.ts
// ─────────────────────────────────────────────────────────────────────────────
// Builds the RetrievalIndex from the already-parsed graph data.
//
// PURPOSE:
//   The RetrievalIndex is a separate data store from the visualization graph.
//   It is designed for AI-driven issue mapping and chat, NOT for visualization.
//   It captures semantic signals (auth checks, DB calls, barrel status, roles)
//   that tell the AI which files and functions are worth fetching.
//
// DESIGN PRINCIPLES:
//   - Pure data transformation — no re-parsing, no disk access, no AST work
//   - Runs AFTER buildGraph() — all data is already available
//   - Completely independent of buildGraph() — can be called or skipped freely
//   - Failure is non-fatal (caller catches and warns)
//
// INPUT:  FileNode[], FunctionNode[], ImportEdge[] (already built by builder.ts)
// OUTPUT: RetrievalIndex (stored in Redis under retrieval:{owner}:{repo})
// ─────────────────────────────────────────────────────────────────────────────

import type {
    FileNode,
    FunctionNode,
    ImportEdge,
} from "../models/graph";

import type {
    RetrievalIndex,
    RetrievalFileEntry,
    RetrievalFunction,
    SemanticRole,
} from "../models/retrieval";

// ── Semantic role heuristics ──────────────────────────────────────────────────
//
// These patterns are checked against the file path (lowercased) and the
// file's function kinds. Order matters — more specific patterns first.
//
// Reasoning:
//   - "resolver" directories are dominant in GraphQL backends (Talawa, etc.)
//   - "mutation" and "query" are common GraphQL code-split patterns
//   - "auth" / "guard" / "permission" are universal across REST and GraphQL
//   - "middleware" catches Express/Koa/NestJS interceptors
//   - "service" / "manager" are business-logic layer patterns
//   - "controller" is a REST-specific pattern
//   - "repository" / "dao" / "store" are data-access layer patterns
//   - "model" / "entity" / "schema" describe ORM model files
//   - "util" / "helper" / "lib" / "common" are utility patterns
//   - "config" / "env" / "setup" are configuration patterns
//   - "test" / "spec" are test file patterns
//   - "__generated__" is GraphQL code-gen output (schema, resolvers)
//   - "types" / "interfaces" are declaration-only patterns

const ROLE_PATTERNS: Array<{ pattern: RegExp; role: SemanticRole }> = [
    // Test files — check first since tests may live in any directory
    { pattern: /\.(test|spec)\.(ts|js|tsx|jsx)$|\/__(tests?|mocks?)__\//i, role: "test" },

    // GraphQL-specific
    { pattern: /\/resolvers?\/|resolver\.(ts|js)$/i, role: "resolver" },
    { pattern: /\/mutations?\/|mutation\.(ts|js)$/i, role: "mutation" },
    { pattern: /\/queries\/|query\.(ts|js)$/i,       role: "query" },
    // GraphQL schema/typedefs — not the same as ORM model
    { pattern: /typeDefs|type-defs|graphql.*schema|schema\.graphql|\.graphql$/i, role: "schema" },
    // Generated GraphQL code — treat as schema
    { pattern: /__generated__|generated-types|codegen/i, role: "schema" },

    // Auth / permissions — universal
    { pattern: /\/auth\/|\/guards?\/|\/permissions?\/|auth\.(ts|js)$/i, role: "auth" },
    { pattern: /\/middleware\/|middleware\.(ts|js)$|\.middleware\.(ts|js)$/i, role: "middleware" },

    // REST-specific controller layer
    { pattern: /\/controllers?\/|controller\.(ts|js)$|\.controller\.(ts|js)$/i, role: "controller" },

    // Business logic / service layer
    { pattern: /\/services?\/|service\.(ts|js)$|\.service\.(ts|js)$|\/managers?\//i, role: "service" },

    // Data access layer
    { pattern: /\/repositor(y|ies)\/|repository\.(ts|js)$|\.repository\.(ts|js)$|\/dao\/|\/stores?\//i, role: "repository" },

    // ORM models / entities
    { pattern: /\/models?\/|\/entities\/|model\.(ts|js)$|\.model\.(ts|js)$|entity\.(ts|js)$|\.entity\.(ts|js)$/i, role: "model" },

    // Config / environment
    { pattern: /\/config\/|config\.(ts|js)$|\.config\.(ts|js)$|\/env\/|env\.(ts|js)$/i, role: "config" },

    // Utilities / helpers — check after service/model so we don't mis-classify
    { pattern: /\/utils?\/|\/helpers?\/|\/lib\/|\/common\/|util\.(ts|js)$|helper\.(ts|js)$/i, role: "util" },
];

/**
 * Determine the semantic role of a file from its path.
 *
 * Falls back to "barrel" if the file is detected as a barrel,
 * then "unknown" if no pattern matches.
 */
function detectSemanticRole(fileId: string, isBarrel: boolean): SemanticRole {
    if (isBarrel) return "barrel";

    const lowerPath = fileId.toLowerCase();
    for (const { pattern, role } of ROLE_PATTERNS) {
        if (pattern.test(lowerPath)) return role;
    }
    return "unknown";
}

// ── Reverse import index ──────────────────────────────────────────────────────

/**
 * Build a map of fileId → Set<fileId> for reverse import lookups.
 * "importedBy" means: given file X, which files import X?
 */
function buildImportedByMap(importEdges: ImportEdge[]): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    for (const edge of importEdges) {
        const set = map.get(edge.target) ?? new Set<string>();
        set.add(edge.source);
        map.set(edge.target, set);
    }
    return map;
}

/**
 * Build a map of fileId → Set<fileId> for forward import lookups.
 * "imports" means: given file X, which files does X import?
 */
function buildImportsMap(importEdges: ImportEdge[]): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    for (const edge of importEdges) {
        const set = map.get(edge.source) ?? new Set<string>();
        set.add(edge.target);
        map.set(edge.source, set);
    }
    return map;
}

// ── Barrel target resolution ──────────────────────────────────────────────────

/**
 * Resolve a barrel file's re-export specifiers to actual fileIds in the graph.
 *
 * A barrel's barrelTargets are the resolved fileIds of the files it re-exports.
 * We find these by looking for ImportEdges from this file with kind "re-export"
 * and collecting their target fileIds.
 */
function resolveBarrelTargets(fileId: string, importEdges: ImportEdge[]): string[] {
    return importEdges
        .filter(e => e.source === fileId && e.kind === "re-export")
        .map(e => e.target);
}

// ── Function mapper ───────────────────────────────────────────────────────────

/**
 * Map a FunctionNode to its RetrievalFunction shape.
 * Carries over the retrieval signals detected in functionLevel.ts.
 */
function mapFunction(fn: FunctionNode): RetrievalFunction {
    return {
        id:              fn.id,
        name:            fn.name,
        filePath:        fn.filePath,
        startLine:       fn.startLine,
        endLine:         fn.endLine,
        kind:            fn.kind,
        isExported:      fn.isExported,
        isAsync:         fn.isAsync ?? false,
        hasAuthCheck:    fn.hasAuthCheck    ?? false,
        hasDatabaseCall: fn.hasDatabaseCall ?? false,
        calls:           fn.calls,
    };
}

// ── Main builder ──────────────────────────────────────────────────────────────

/**
 * Build the RetrievalIndex from already-parsed graph data.
 *
 * This is a pure transformation — all data comes from the graph builder output.
 * No re-parsing, no disk access, no AST work.
 *
 * @param owner       GitHub repo owner
 * @param repo        GitHub repo name
 * @param commitSha   The commit SHA this analysis is based on
 * @param fileNodes   All parsed FileNodes (from builder.ts)
 * @param importEdges All resolved ImportEdges (from builder.ts)
 * @param allFunctions All extracted FunctionNodes (from chunkProcessor)
 */
export function buildRetrievalIndex(
    owner: string,
    repo: string,
    commitSha: string,
    fileNodes: FileNode[],
    importEdges: ImportEdge[],
    allFunctions: FunctionNode[],
): RetrievalIndex {
    const repoId = `${owner}/${repo}`;
    console.log(`[retrievalBuilder] building retrieval index for ${repoId}`);

    // ── Build lookup structures ───────────────────────────────────────────────
    const importedByMap = buildImportedByMap(importEdges);
    const importsMap    = buildImportsMap(importEdges);

    // Group functions by file for fast lookup
    const functionsByFile = new Map<string, FunctionNode[]>();
    for (const fn of allFunctions) {
        const existing = functionsByFile.get(fn.filePath) ?? [];
        existing.push(fn);
        functionsByFile.set(fn.filePath, existing);
    }

    // ── Build file entries ────────────────────────────────────────────────────
    const files: RetrievalFileEntry[] = fileNodes.map((file) => {
        const isBarrel = file.isBarrel ?? false;
        const barrelTargets = isBarrel
            ? resolveBarrelTargets(file.id, importEdges)
            : [];

        const semanticRole = detectSemanticRole(file.id, isBarrel);

        const importedBy = [...(importedByMap.get(file.id) ?? [])];
        const imports    = [...(importsMap.get(file.id) ?? [])];

        const fileFunctions = (functionsByFile.get(file.id) ?? []).map(mapFunction);

        return {
            fileId:       file.id,
            isBarrel,
            barrelTargets,
            semanticRole,
            importedBy,
            imports,
            functions:    fileFunctions,
        };
    });

    const authCount = files.reduce(
        (sum, f) => sum + f.functions.filter(fn => fn.hasAuthCheck).length, 0
    );
    const dbCount = files.reduce(
        (sum, f) => sum + f.functions.filter(fn => fn.hasDatabaseCall).length, 0
    );
    const barrelCount = files.filter(f => f.isBarrel).length;

    console.log(
        `[retrievalBuilder] built retrieval index: ` +
        `${files.length} files, ` +
        `${barrelCount} barrels, ` +
        `${authCount} auth-check functions, ` +
        `${dbCount} db-call functions`
    );

    return {
        repoId,
        commitSha,
        generatedAt: new Date().toISOString(),
        files,
    };
}
