// src/parser/deadCodeAnalyzer.ts
// ─────────────────────────────────────────────────────────────────────────────
// Weighted dead code / orphan detection.
//
// Uses a multi-signal scoring system (not naive binary isolation) to determine
// how likely a file or symbol is unused. Each signal contributes a weighted
// penalty toward a composite "deadCodeScore" (0–100).
//
// Design principles:
//   - Deterministic: every score is reproducible from the graph alone
//   - Weighted: files with partial connectivity get intermediate scores
//   - Conservative: entry points, tests, configs are never dead
//   - Symbol-level: exported functions not imported anywhere are flagged
// ─────────────────────────────────────────────────────────────────────────────

import type { FileNode, ImportEdge, FunctionNode } from "../models/schema";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Files scoring at or above this threshold are marked isDeadCode = true */
const DEAD_CODE_THRESHOLD = 65;

// ── Scoring weights ───────────────────────────────────────────────────────────

interface DeadCodeSignals {
    /** File has zero incoming import edges (nobody imports it) */
    zeroInDegree: boolean;
    /** File has zero outgoing import edges (imports nothing) */
    zeroOutDegree: boolean;
    /** File has zero functions extracted */
    noFunctions: boolean;
    /** File is not an entry point */
    notEntryPoint: boolean;
    /** File is not a test file */
    notTestFile: boolean;
    /** File is not a config file */
    notConfigFile: boolean;
    /** None of the file's exports are imported by other files */
    allExportsUnused: boolean;
    /** File sits in a penalty folder (examples, fixtures, etc.) */
    inPenaltyFolder: boolean;
    /** File has very low architectural importance */
    lowArchImportance: boolean;
    /** File line count — very small files are more likely to be dead stubs */
    isStubFile: boolean;
}

const SIGNAL_WEIGHTS: Record<keyof DeadCodeSignals, number> = {
    zeroInDegree:      25,   // strongest signal — nobody imports this
    allExportsUnused:  20,   // exports exist but nobody uses them
    zeroOutDegree:     10,   // isolated from the dependency graph
    notEntryPoint:     10,   // entry points are never dead by definition
    notTestFile:       5,    // tests are never dead
    notConfigFile:     5,    // configs are never dead
    noFunctions:       5,    // files with no functions are often stubs/dead
    inPenaltyFolder:   10,   // example/fixture folders contain dead-ish code
    lowArchImportance: 5,    // low centrality reinforces dead signal
    isStubFile:        5,    // very small files are often stubs
};

// ── Penalty folder detection ──────────────────────────────────────────────────

const PENALTY_SEGMENTS = new Set([
    "example", "examples", "demo", "demos",
    "fixture", "fixtures", "seed", "seeds",
    "scaffold", "scaffolds", "storybook", ".storybook",
    "bench", "benchmarks", "docs", "documentation",
]);

function isInPenaltyFolder(filePath: string): boolean {
    const segments = filePath.split("/");
    return segments.some(s => PENALTY_SEGMENTS.has(s.toLowerCase()));
}

// ── Framework semantic entry file detection ────────────────────────────────────
//
// These files export symbols consumed by the framework router, not by import
// edges in the graph. Treating their exports as "unused" is always a false
// positive, so we exempt them from symbol-level analysis entirely.

/**
 * Stem patterns that identify framework-discovered route/layout files.
 * Matched against the bare filename (no extension, no directory).
 */
const FRAMEWORK_ROUTE_STEMS = new Set([
    "page",       // Next.js App Router pages
    "layout",     // Next.js layouts
    "route",      // Next.js API routes (app/)
    "loading",    // Next.js loading UI
    "error",      // Next.js error boundary
    "not-found",  // Next.js 404 page
    "template",   // Next.js template
    "middleware", // Next.js / Nuxt middleware
    "_app",       // Next.js Pages Router app wrapper
    "_document",  // Next.js Pages Router document
    "index",      // Treated conservatively — only exempt if already an entry point
]);

/**
 * Returns true if this file is a framework semantic entry:
 *   1. Already scored as an entry point, OR
 *   2. Its filename stem matches a known framework route pattern
 *
 * These files must NOT be flagged for unused exports or orphan symbols
 * because their exports are consumed by the framework router, not by
 * explicit import edges visible in the static dependency graph.
 */
function isFrameworkSemanticFile(file: { id: string; isEntryPoint: boolean }): boolean {
    if (file.isEntryPoint) return true;

    // Extract bare filename stem (e.g. "page" from "src/app/orders/[id]/page.jsx")
    const basename = file.id.split("/").pop() ?? "";
    const stem = basename.replace(/\.[^.]+$/, "").toLowerCase();

    return FRAMEWORK_ROUTE_STEMS.has(stem);
}

// ── Symbol-level analysis ─────────────────────────────────────────────────────

/**
 * Find exported symbols from a file that are never imported by any other file.
 * Uses the import edge symbols array for lookup.
 */
function findUnusedExports(
    fileId: string,
    functions: FunctionNode[],
    allImportEdges: ImportEdge[],
): string[] {
    // Collect all exported function names from this file
    const exportedNames = functions
        .filter(fn => fn.isExported && fn.filePath === fileId)
        .map(fn => fn.name);

    if (exportedNames.length === 0) return [];

    // Collect all symbols imported FROM this file by any other file
    const importedSymbols = new Set<string>();
    for (const edge of allImportEdges) {
        if (edge.target === fileId) {
            for (const sym of edge.symbols) {
                importedSymbols.add(sym);
            }
        }
    }

    // Symbols exported but never imported
    return exportedNames.filter(name => !importedSymbols.has(name));
}

/**
 * Find internal (non-exported) functions that are never called by anything.
 */
function findOrphanSymbols(
    fileId: string,
    functions: FunctionNode[],
): string[] {
    const fileFunctions = functions.filter(fn => fn.filePath === fileId);
    return fileFunctions
        .filter(fn =>
            !fn.isExported &&
            fn.calledBy.length === 0 &&
            fn.kind !== "test" &&
            fn.kind !== "constructor"
        )
        .map(fn => fn.name);
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface DeadCodeStats {
    deadCodeFiles: number;
    totalUnusedExports: number;
    totalOrphanSymbols: number;
}

/**
 * Analyse all files for dead code using weighted multi-signal scoring.
 * Mutates fileNodes in-place — sets deadCodeScore, isDeadCode, unusedExports, orphanSymbols.
 *
 * Must be called AFTER entry scoring and graph analytics (so isEntryPoint,
 * architecturalImportance, etc. are already populated).
 */
export function analyzeDeadCode(
    fileNodes: FileNode[],
    importEdges: ImportEdge[],
    allFunctions: FunctionNode[],
): DeadCodeStats {
    // Build degree maps
    const inDegree  = new Map<string, number>();
    const outDegree = new Map<string, number>();

    for (const edge of importEdges) {
        outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
        inDegree.set(edge.target,  (inDegree.get(edge.target)  ?? 0) + 1);
    }

    let deadCodeFiles = 0;
    let totalUnusedExports = 0;
    let totalOrphanSymbols = 0;

    for (const file of fileNodes) {
        const inD  = inDegree.get(file.id)  ?? 0;
        const outD = outDegree.get(file.id) ?? 0;

        // Symbol-level analysis — skip for framework semantic files to avoid
        // false positives on framework-router-consumed exports (page.jsx default,
        // layout.jsx default, route.ts handlers, etc.)
        const isFramework = isFrameworkSemanticFile(file);
        const unusedExports = isFramework ? [] : findUnusedExports(file.id, allFunctions, importEdges);
        const orphanSymbols = isFramework ? [] : findOrphanSymbols(file.id, allFunctions);

        file.unusedExports = unusedExports;
        file.orphanSymbols = orphanSymbols;
        totalUnusedExports += unusedExports.length;
        totalOrphanSymbols += orphanSymbols.length;

        // Evaluate all signals
        const signals: DeadCodeSignals = {
            zeroInDegree:      inD === 0,
            zeroOutDegree:     outD === 0,
            noFunctions:       (file.functions?.length ?? 0) === 0,
            notEntryPoint:     !file.isEntryPoint,
            notTestFile:       file.kind !== "test",
            notConfigFile:     file.kind !== "config" && file.kind !== "declaration",
            allExportsUnused:  unusedExports.length > 0 && unusedExports.length >= (file.functions?.filter(f => f.isExported).length ?? 0),
            inPenaltyFolder:   isInPenaltyFolder(file.id),
            lowArchImportance: (file.architecturalImportance ?? 0) < 5,
            isStubFile:        file.lineCount < 10,
        };

        // Calculate composite score
        let score = 0;
        for (const [signal, active] of Object.entries(signals) as [keyof DeadCodeSignals, boolean][]) {
            if (active) score += SIGNAL_WEIGHTS[signal];
        }

        // Cap at 100
        score = Math.min(100, score);

        // Framework semantic files, entry points, tests, and configs are NEVER
        // dead — force score to 0. isFramework already covers isEntryPoint but
        // we keep the explicit check here for clarity and safety.
        if (isFramework || file.kind === "test" || file.kind === "config" || file.kind === "declaration") {
            score = 0;
        }

        file.deadCodeScore = score;
        file.isDeadCode = score >= DEAD_CODE_THRESHOLD;

        if (file.isDeadCode) deadCodeFiles++;
    }

    console.log(
        `[deadCodeAnalyzer] scored ${fileNodes.length} files — ` +
        `${deadCodeFiles} dead code files (threshold=${DEAD_CODE_THRESHOLD}), ` +
        `${totalUnusedExports} unused exports, ${totalOrphanSymbols} orphan symbols`
    );

    return { deadCodeFiles, totalUnusedExports, totalOrphanSymbols };
}
