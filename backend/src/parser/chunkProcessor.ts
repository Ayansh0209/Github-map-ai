// src/parser/chunkProcessor.ts
// Processes files in batches of 50 to keep RAM flat
// Each batch gets its own ts-morph Project instance — disposed after use
// This is the only file that touches ts-morph directly

import path from "path";
import fs from "fs";
import { Project, ScriptTarget, ModuleKind } from "ts-morph";
import { ParseDecision } from "../processing/sizeHandler";
import { FileNode, ImportEdge, FunctionNode, FileKind } from "../models/schema";
import { extractFileLevel } from "./fileLevel";
import { extractFunctionLevel } from "./functionLevel";
import { ImportResolver } from "./importResolver";

const CHUNK_SIZE = 50;
const CHUNK_PAUSE_MS = 100; // breathing room between chunks

// ── Chunk helper ─────────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── File kind / entry point helpers ──────────────────────────────────────────

function detectFileKind(relativePath: string): FileKind {
    const filename = path.basename(relativePath).toLowerCase();
    if (filename.endsWith(".d.ts")) return "declaration";
    if (
        filename.includes(".test.") ||
        filename.includes(".spec.") ||
        filename.includes("__tests__")
    ) return "test";
    if (
        filename.startsWith("jest.config") ||
        filename.startsWith("vite.config") ||
        filename.startsWith("webpack.config") ||
        filename.startsWith("tsdown.config") ||
        filename.startsWith("rollup.config") ||
        filename.startsWith("eslint.config") ||
        filename.startsWith("prettier.config") ||
        filename.startsWith("lint-staged.config") ||
        filename.startsWith("babel.config") ||
        filename.startsWith("next.config") ||
        filename.startsWith("nuxt.config") ||
        filename.startsWith("tailwind.config") ||
        filename.startsWith("postcss.config")
    ) return "config";
    return "source";
}

function detectIsEntryPoint(relativePath: string): boolean {
    const filename = path.basename(relativePath).toLowerCase();
    const ENTRY_NAMES = new Set([
        "index.ts", "index.js", "index.tsx", "index.jsx",
        "main.ts", "main.js",
        "server.ts", "server.js",
        "app.ts", "app.js",
        "entry.ts", "entry.js",
    ]);
    return ENTRY_NAMES.has(filename);
}

function countLines(absolutePath: string): number {
    try {
        const content = fs.readFileSync(absolutePath, "utf-8");
        return content.split("\n").length;
    } catch {
        return 0;
    }
}

// ── Result types ─────────────────────────────────────────────────────────────

export interface ChunkResult {
    fileNodes: FileNode[];
    importEdges: ImportEdge[];
    allFunctions: FunctionNode[];  // flat list — builder attaches to files
}

// ── Single chunk processor ────────────────────────────────────────────────────

async function processChunk(
    decisions: ParseDecision[],
    repoRoot: string,
    resolver: ImportResolver,
    chunkIndex: number
): Promise<ChunkResult> {
    const fileNodes: FileNode[] = [];
    const importEdges: ImportEdge[] = [];
    const allFunctions: FunctionNode[] = [];

    // One Project per chunk — disposed at end of this function
    const project = new Project({
        useInMemoryFileSystem: false,
        compilerOptions: {
            target: ScriptTarget.Latest,
            module: ModuleKind.CommonJS,
            allowJs: true,           // parse .js files too
            jsx: 4,                  // JsxEmit.ReactJSX — handles .tsx/.jsx
            skipLibCheck: true,      // don't type-check, just parse
            noEmit: true,
        },
    });

    // Add all files in this chunk to the project
    for (const decision of decisions) {
        try {
            project.addSourceFileAtPath(decision.absolutePath);
        } catch (err) {
            // file unreadable — log and skip, never crash the whole job
            console.warn(
                `[chunkProcessor] Could not add file: ${decision.relativePath} — ${(err as Error).message}`
            );
        }
    }

    // Process each file
    for (const decision of decisions) {
        const sourceFile = project.getSourceFile(decision.absolutePath);

        if (!sourceFile) {
            // was skipped during addSourceFileAtPath
            continue;
        }

        try {
            // ── File level: imports + exports ─────────────────────────────
            const fileLevelResult = extractFileLevel(
                sourceFile,
                decision.relativePath
            );

            // Resolve raw imports → ImportEdges
            const resolvedEdges: ImportEdge[] = [];
            const unresolvedImports: string[] = [];

            for (const rawImport of fileLevelResult.rawImports) {
                const resolved = resolver.resolve(
                    rawImport.specifier,
                    decision.absolutePath
                );

                if (resolved.kind === "internal") {
                    resolvedEdges.push({
                        source: decision.relativePath,
                        target: resolved.resolvedPath,
                        kind: rawImport.kind,
                        symbols: rawImport.symbols,
                        isTypeOnly: rawImport.isTypeOnly,
                    });
                } else if (
                    rawImport.specifier.startsWith(".") &&
                    resolved.kind === "external"
                ) {
                    // relative import that couldn't be resolved on disk — truly unresolved
                    unresolvedImports.push(rawImport.specifier);
                }
                // external (node_modules) imports are recorded on FileNode, not as edges
            }

            importEdges.push(...resolvedEdges);

            // ── Function level: only for "full" parse files ───────────────
            const functions: FunctionNode[] =
                decision.mode === "full"
                    ? extractFunctionLevel(sourceFile, decision.relativePath)
                    : [];

            allFunctions.push(...functions);

            // ── Build FileNode ────────────────────────────────────────────
            const ext = decision.relativePath.split(".").pop() ?? "";
            const language =
                ext === "ts" || ext === "tsx"
                    ? "typescript"
                    : ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs"
                        ? "javascript"
                        : "unknown";

            fileNodes.push({
                id: decision.relativePath,
                label: path.basename(decision.relativePath),
                language,
                path: decision.relativePath,
                sizeBytes: decision.sizeBytes,
                lineCount: countLines(decision.absolutePath),
                parseStatus: decision.mode === "skip" ? "skipped" : decision.mode,
                kind: detectFileKind(decision.relativePath),
                isEntryPoint: detectIsEntryPoint(decision.relativePath),
                functions,
                externalImports: fileLevelResult.externalImports,
                unresolvedImports,
            });

        } catch (err) {
            // parsing this file failed — add it as a minimal node, never crash
            console.warn(
                `[chunkProcessor] Parse error in ${decision.relativePath}: ${(err as Error).message}`
            );

            fileNodes.push({
                id: decision.relativePath,
                label: path.basename(decision.relativePath),
                language: "unknown",
                path: decision.relativePath,
                sizeBytes: decision.sizeBytes,
                lineCount: countLines(decision.absolutePath),
                parseStatus: "skipped",
                kind: detectFileKind(decision.relativePath),
                isEntryPoint: detectIsEntryPoint(decision.relativePath),
                functions: [],
                externalImports: [],
                unresolvedImports: [],
            });
        }
    }

    // IMPORTANT: dispose project to free ts-morph memory
    project.getSourceFiles().forEach((sf) => project.removeSourceFile(sf));

    return { fileNodes, importEdges, allFunctions };
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function processAllFiles(
    decisions: ParseDecision[],
    repoRoot: string,
    onProgress?: (processedSoFar: number, total: number) => void
): Promise<ChunkResult> {
    // Filter out "skip" mode — don't pass to ts-morph at all
    const filesToParse = decisions.filter((d) => d.mode !== "skip");
    const skippedFiles = decisions.filter((d) => d.mode === "skip");

    const resolver = new ImportResolver(repoRoot);
    const chunks = chunkArray(filesToParse, CHUNK_SIZE);

    const allFileNodes: FileNode[] = [];
    const allImportEdges: ImportEdge[] = [];
    const allFunctions: FunctionNode[] = [];

    console.log(
        `[chunkProcessor] ${filesToParse.length} files to parse in ${chunks.length} chunks`
    );

    let processedCount = 0;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(
            `[chunkProcessor] chunk ${i + 1}/${chunks.length} — ${chunk.length} files`
        );

        const result = await processChunk(chunk, repoRoot, resolver, i);

        allFileNodes.push(...result.fileNodes);
        allImportEdges.push(...result.importEdges);
        allFunctions.push(...result.allFunctions);

        processedCount += chunk.length;
        onProgress?.(processedCount, filesToParse.length);

        // breathing room between chunks — lets GC run
        if (i < chunks.length - 1) {
            await sleep(CHUNK_PAUSE_MS);
        }
    }

    // Add skipped files as minimal FileNodes so they appear in graph
    for (const decision of skippedFiles) {
        allFileNodes.push({
            id: decision.relativePath,
            label: path.basename(decision.relativePath),
            language: "unknown",
            path: decision.relativePath,
            sizeBytes: decision.sizeBytes,
            lineCount: countLines(decision.absolutePath),
            parseStatus: "skipped",
            kind: detectFileKind(decision.relativePath),
            isEntryPoint: detectIsEntryPoint(decision.relativePath),
            functions: [],
            externalImports: [],
            unresolvedImports: [],
        });
    }

    console.log(
        `[chunkProcessor] done — ` +
        `${allFileNodes.length} files, ` +
        `${allImportEdges.length} import edges, ` +
        `${allFunctions.length} functions`
    );

    return {
        fileNodes: allFileNodes,
        importEdges: allImportEdges,
        allFunctions,
    };
}