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
        },
    };

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

    return { graphData, fileGraph, functionFiles };
}