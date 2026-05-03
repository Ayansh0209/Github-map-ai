// src/graph/builder.ts
// Takes raw parser output and assembles the final GraphData object
// This is the only file that knows about the full graph structure

import path from "path";
import {
    FileNode,
    FunctionNode,
    ImportEdge,
    CallEdge,
    GraphData,
    BuilderInput,
    BuilderOutput,
    FileGraphPayload,
    FunctionFilePayload,
} from "../models/schema";
import { applyEntryScoring } from "./entryScorer";
import { applyGraphAnalytics } from "./graphAnalytics";
import { detectWorkspaces, resolveFilePackage } from "./workspaceResolver";
import { analyzeDeadCode } from "./deadCodeAnalyzer";
import { buildSearchIndex } from "../search/searchIndexer";
import { extractRepoMetadata } from "./repoMetadata";


// ── Helpers ───────────────────────────────────────────────────────────────────


function sanitizeFileId(relativePath: string): string {
    // "src/utils/parser.ts" → "src-utils-parser.ts"
    // used as R2 key and URL segment
    return relativePath.replace(/[/\\]/g, "-").replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

function deduplicateImportEdges(edges: ImportEdge[]): ImportEdge[] {
    const seen = new Set<string>();
    const result: ImportEdge[] = [];

    for (const edge of edges) {
        // deduplicate by source + target + kind
        const key = `${edge.source}→${edge.target}:${edge.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(edge);
    }

    return result;
}

// ── Main builder ──────────────────────────────────────────────────────────────

export function buildGraph(input: BuilderInput): BuilderOutput {
    const { owner, repo, commitSha, fileNodes, importEdges, allFunctions,
            startupSignals, routeHandlers, repoRoot } = input;
    const repoId = `${owner}/${repo}`;
    const generatedAt = new Date().toISOString();

    console.log(`[builder] building graph for ${repoId}`);
    console.log(`[builder] input: ${fileNodes.length} files, ${importEdges.length} import edges, ${allFunctions.length} functions`);

    // ── Step 1: Normalise paths + build file ID set ───────────────────────────
    // Windows produces backslashes; normalise everything to forward slashes
    // so comparisons work identically on Windows dev and Linux Railway
    for (const file of fileNodes) {
        file.id   = file.id.replace(/\\/g, "/");
        file.path = file.path.replace(/\\/g, "/");
    }

    for (const fn of allFunctions) {
        fn.filePath = fn.filePath.replace(/\\/g, "/");
        fn.id       = fn.id.replace(/\\/g, "/");
    }

    const fileIdSet = new Set<string>(fileNodes.map((f) => f.id));

    // ── Step 2: Deduplicate and validate import edges ─────────────────────────
    // normalise edge paths before dedup so duplicates aren't missed
    for (const edge of importEdges) {
        edge.source = edge.source.replace(/\\/g, "/");
        edge.target = edge.target.replace(/\\/g, "/");
    }

    const deduped = deduplicateImportEdges(importEdges);

    // filter out edges where target file doesn't exist in our graph
    // this catches unresolved aliases or files outside the repo
    const validImportEdges: ImportEdge[] = [];
    let orphanCount = 0;

    for (const edge of deduped) {
        if (!fileIdSet.has(edge.target)) {
            orphanCount++;
            continue; // drop orphan — log below
        }
        validImportEdges.push(edge);
    }

    if (orphanCount > 0) {
        console.log(`[builder] dropped ${orphanCount} orphan import edges (target file not in graph)`);
    }

    // ── Step 2.5: Apply entry point scoring ──────────────────────────────────
    // Run AFTER dedup and validation so inDegree/outDegree counts are based on
    // real edges only. entryScorer mutates fileNodes in place.
    applyEntryScoring(fileNodes, validImportEdges, {
        repoRoot:       repoRoot ?? "",
        startupSignals: startupSignals ?? new Map(),
        routeHandlers:  routeHandlers  ?? new Map(),
    });

    // ── Step 2.6: Mark Test Coverage Edges ───────────────────────────────────
    for (const edge of validImportEdges) {
        const sourceFile = fileNodes.find(f => f.id === edge.source);
        if (sourceFile && sourceFile.kind === "test") {
            edge.isTestCoverage = true;
            // Also link the function nodes if needed, but file-level coverage is here.
        }
    }

    // ── Step 2.7: Graph Analytics (SCC & Weighting) ─────────────────────────
    const analyticsStats = applyGraphAnalytics(fileNodes, validImportEdges);
    console.log(`[builder] graph analytics: found ${analyticsStats.cycleCount} circular dependency cycles containing ${analyticsStats.filesInCycles} files`);

    // ── Step 2.8: Compute scores on each FileNode ────────────────────────────
    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();
    for (const edge of validImportEdges) {
        outDegree.set(edge.source, (outDegree.get(edge.source) || 0) + 1);
        inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    }

    const totalFiles = fileNodes.length;
    for (const file of fileNodes) {
        let cycleScore = 0;
        for (const edge of validImportEdges) {
            if (edge.isCircular === true && (edge.source === file.id || edge.target === file.id)) {
                cycleScore++;
            }
        }

        const inD = inDegree.get(file.id) ?? 0;
        const outD = outDegree.get(file.id) ?? 0;
        let hubScore = ((inD * 2 + outD) / totalFiles) * 100;
        hubScore = Math.round(hubScore * 100) / 100;

        const entry = file.isEntryPoint ? 30 : 0;
        const cycle = cycleScore * 5;
        let architecturalImportance = hubScore + entry + cycle;
        if (architecturalImportance > 100) architecturalImportance = 100;
        architecturalImportance = Math.round(architecturalImportance * 100) / 100;

        file.cycleScore = cycleScore;
        file.hubScore = hubScore;
        file.architecturalImportance = architecturalImportance;
    }

    const top5 = [...fileNodes]
        .sort((a, b) => (b.architecturalImportance ?? 0) - (a.architecturalImportance ?? 0))
        .slice(0, 5);

    console.log("[builder] top 5 by architectural importance:");
    top5.forEach(f =>
        console.log(`  ${f.id} — importance: ${f.architecturalImportance} hub: ${f.hubScore} entry: ${f.isEntryPoint}`)
    );

    // ── Step 2.9: Workspace / Monorepo Resolution ────────────────────────────
    const workspaceInfo = repoRoot ? detectWorkspaces(repoRoot) : undefined;
    if (workspaceInfo && workspaceInfo.packages.length > 0) {
        for (const file of fileNodes) {
            const pkg = resolveFilePackage(file.id, workspaceInfo.packages);
            if (pkg) {
                file.workspacePackage = pkg.name;
                file.packageRoot = pkg.root;
                file.packageName = pkg.name;
            }
        }
    }

    // ── Step 2.10: Dead Code Analysis ─────────────────────────────────────────
    const deadCodeStats = analyzeDeadCode(fileNodes, validImportEdges, allFunctions);

    // ── Step 3: Build function ID map ─────────────────────────────────────────
    // maps function name → array of FunctionNode IDs
    // array because same name can exist in different files
    const functionsByName = new Map<string, string[]>();
    const functionIdSet = new Set<string>();

    for (const fn of allFunctions) {
        functionIdSet.add(fn.id);

        // index by bare name for call resolution
        const existing = functionsByName.get(fn.name) ?? [];
        existing.push(fn.id);
        functionsByName.set(fn.name, existing);

        // also index by last segment of class.method names
        // "MyClass.myMethod" → also index as "myMethod"
        if (fn.name.includes(".")) {
            const methodName = fn.name.split(".").pop()!;
            const existingMethod = functionsByName.get(methodName) ?? [];
            existingMethod.push(fn.id);
            functionsByName.set(methodName, existingMethod);
        }
    }

    // ── Step 4: Resolve call edges + build calledBy ───────────────────────────
    // calls[] contains raw names like "parse", "format"
    // we resolve them to full FunctionNode IDs
    const callEdges: CallEdge[] = [];
    const calledByMap = new Map<string, Set<string>>(); // targetId → Set of callerIds

    for (const fn of allFunctions) {
        for (const rawCallName of fn.calls) {
            const candidates = functionsByName.get(rawCallName);
            if (!candidates || candidates.length === 0) continue;

            // prefer same-file call if multiple candidates
            const sameFile = candidates.find((id) =>
                id.startsWith(fn.filePath + "::")
            );
            const targetId = sameFile ?? candidates[0];

            // skip self-calls
            if (targetId === fn.id) continue;

            callEdges.push({
                source: fn.id,
                target: targetId,
                kind: "direct",
            });

            // build calledBy reverse index
            const callers = calledByMap.get(targetId) ?? new Set();
            callers.add(fn.id);
            calledByMap.set(targetId, callers);
        }
    }

    // deduplicate call edges
    const seenCallEdges = new Set<string>();
    const uniqueCallEdges: CallEdge[] = [];
    for (const edge of callEdges) {
        const key = `${edge.source}→${edge.target}`;
        if (seenCallEdges.has(key)) continue;
        seenCallEdges.add(key);
        uniqueCallEdges.push(edge);
    }

    console.log(`[builder] resolved ${uniqueCallEdges.length} call edges`);

    // ── Step 5: Apply calledBy back onto FunctionNodes ────────────────────────
    // build a map for fast lookup
    const functionMap = new Map<string, FunctionNode>();
    for (const fn of allFunctions) {
        functionMap.set(fn.id, fn);
    }

    for (const [targetId, callerIds] of calledByMap.entries()) {
        const fn = functionMap.get(targetId);
        if (!fn) continue;
        fn.calledBy = [...callerIds];
    }

    // also resolve calls[] from raw names → full IDs on each FunctionNode
    for (const fn of allFunctions) {
        const resolvedCalls: string[] = [];

        for (const rawCallName of fn.calls) {
            const candidates = functionsByName.get(rawCallName);
            if (!candidates || candidates.length === 0) continue;

            const sameFile = candidates.find((id) =>
                id.startsWith(fn.filePath + "::")
            );
            const targetId = sameFile ?? candidates[0];
            if (targetId === fn.id) continue; // skip self
            resolvedCalls.push(targetId);
        }

        fn.calls = [...new Set(resolvedCalls)]; // deduplicate
    }

    // ── Step 6: Attach resolved functions back to FileNodes ───────────────────
    const functionsByFile = new Map<string, FunctionNode[]>();
    for (const fn of allFunctions) {
        const existing = functionsByFile.get(fn.filePath) ?? [];
        existing.push(fn);
        functionsByFile.set(fn.filePath, existing);
    }

    for (const file of fileNodes) {
        file.functions = functionsByFile.get(file.id) ?? [];
    }

    // ── Step 7: Assemble final GraphData ──────────────────────────────────────
    const graphData: GraphData = {
        repoId,
        commitSha,
        files: fileNodes,
        importEdges: validImportEdges,
        callEdges: uniqueCallEdges,
        generatedAt,
        stats: {
            totalFiles: fileNodes.length,
            parsedFiles: fileNodes.filter((f) => f.parseStatus !== "skipped").length,
            totalFunctions: allFunctions.length,
            totalImportEdges: validImportEdges.length,
            totalCallEdges: uniqueCallEdges.length,
            testFiles: fileNodes.filter((f) => f.kind === "test").length,
            entryPoints: fileNodes.filter((f) => f.isEntryPoint).length,
            deadCodeFiles: deadCodeStats.deadCodeFiles,
            workspacePackages: workspaceInfo?.packages.length ?? 0,
        },
        workspaceInfo,
    };

    // ── Step 7.5: Attach repo metadata ────────────────────────────────────────
    if (repoRoot) {
        graphData.repoMetadata = extractRepoMetadata(
            repoRoot,
            workspaceInfo?.packages ?? [],
        );
    }

    // ── Step 8: Validation — log anomalies, never crash ───────────────────────
    let selfCallCount = 0;
    for (const edge of uniqueCallEdges) {
        if (edge.source === edge.target) selfCallCount++;
    }
    if (selfCallCount > 0) {
        console.warn(`[builder] warning: ${selfCallCount} self-call edges detected`);
    }

    console.log(`[builder] graph built:`);
    console.log(`[builder]   files: ${graphData.stats.totalFiles}`);
    console.log(`[builder]   parsed: ${graphData.stats.parsedFiles}`);
    console.log(`[builder]   functions: ${graphData.stats.totalFunctions}`);
    console.log(`[builder]   import edges: ${graphData.stats.totalImportEdges}`);
    console.log(`[builder]   call edges: ${graphData.stats.totalCallEdges}`);

    // ── Step 9: Split into file_graph + per-file function payloads ────────────

    // file_graph.json — loaded first by frontend, kept small
    // strip functions array from file nodes to keep size down
    const fileGraph: FileGraphPayload = {
        repoId,
        commitSha,
        generatedAt,
        stats: graphData.stats,
        files: fileNodes.map(({ functions, ...rest }) => rest),
        importEdges: validImportEdges,
    };

    // per-file function payloads — lazy loaded when user clicks a file
    const functionFiles = new Map<string, FunctionFilePayload>();

    for (const file of fileNodes) {
        if (file.functions.length === 0) continue; // skip files with no functions

        const fileFunctions = file.functions;

        // only include call edges that involve this file's functions
        const fileFunctionIds = new Set(fileFunctions.map((f) => f.id));
        const fileCallEdges = uniqueCallEdges.filter(
            (e) => fileFunctionIds.has(e.source) || fileFunctionIds.has(e.target)
        );

        const sanitizedId = sanitizeFileId(file.id);

        functionFiles.set(sanitizedId, {
            fileId: file.id,
            functions: fileFunctions,
            callEdges: fileCallEdges,
        });
    }

    console.log(`[builder] split into 1 file_graph + ${functionFiles.size} function files`);

    // ── Step 10: Build search index ────────────────────────────────────────────
    const searchIndex = buildSearchIndex(fileNodes, allFunctions, validImportEdges);

    return { graphData, fileGraph, functionFiles, searchIndex };
}