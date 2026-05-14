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


function detectSemanticRole(fileId: string, isBarrel: boolean): SemanticRole {
    if (isBarrel) return "barrel";

    // Test file detection — universal across all JS/TS projects
    if (/\.(test|spec)\.(ts|js|tsx|jsx)$|\/__(tests?|mocks?)__\//i.test(fileId)) {
        return "test";
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
        id: fn.id,
        name: fn.name,
        filePath: fn.filePath,
        startLine: fn.startLine,
        endLine: fn.endLine,
        kind: fn.kind,
        isExported: fn.isExported,
        isAsync: fn.isAsync ?? false,
        hasAuthCheck: fn.hasAuthCheck ?? false,
        hasDatabaseCall: fn.hasDatabaseCall ?? false,
        calls: fn.calls,
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
    const importsMap = buildImportsMap(importEdges);

    // Group functions by file for fast lookup
    const functionsByFile = new Map<string, FunctionNode[]>();
    for (const fn of allFunctions) {
        const existing = functionsByFile.get(fn.filePath) ?? [];
        existing.push(fn);
        functionsByFile.set(fn.filePath, existing);
    }

    // ── Build file entries ────────────────────────────────────────────────────
    // Pre-build a set of files that have re-export edges — used for fallback
    // barrel detection when the parser did not set isBarrel on FileNode.
    const filesWithReExports = new Set<string>(
        importEdges
            .filter(e => e.kind === "re-export")
            .map(e => e.source)
    );

    const files: RetrievalFileEntry[] = fileNodes.map((file) => {
        const fileFunctionsRaw = functionsByFile.get(file.id) ?? [];
        const fileStructures = (file.structures ?? []);

        // Barrel detection with fallback:
        // 1. Use parser-set isBarrel if available
        // 2. Fallback: no functions, no structures, has re-export edges
        //    This catches index.ts files the parser missed
        const isBarrel = file.isBarrel === true || (
            fileFunctionsRaw.length === 0 &&
            fileStructures.length === 0 &&
            filesWithReExports.has(file.id)
        );

        const barrelTargets = isBarrel
            ? resolveBarrelTargets(file.id, importEdges)
            : [];

        const semanticRole = detectSemanticRole(file.id, isBarrel);

        const importedBy = [...(importedByMap.get(file.id) ?? [])];
        const imports = [...(importsMap.get(file.id) ?? [])];

        const fileFunctions = fileFunctionsRaw.map(mapFunction);

        const structures = fileStructures.map(s => ({
            name: s.name,
            startLine: s.startLine,
            endLine: s.endLine,
        }));

        return {
            fileId: file.id,
            isBarrel,
            barrelTargets,
            semanticRole,
            importedBy,
            imports,
            functions: fileFunctions,
            structures,
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
