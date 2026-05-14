// src/parser/snippetFetcher.ts
// ─────────────────────────────────────────────────────────────────────────────
// Bridges candidate file IDs → actual code bodies for Gemini to reason over.
//
// Phase 3 redesign:
//   Removed all scoring-based function selection:
//     - scoreFunctionAgainstIntent() — deleted
//     - intentHasAuth / intentHasData checks — deleted
//     - FUNCTION_SCORE_THRESHOLD — deleted
//     - hasAuthCheck / hasDatabaseCall boosts — deleted
//     - function kind weights (resolver, middleware, etc.) — deleted
//
//   New function selection logic (per candidate source):
//     - PR-sourced: take top exported functions (or all if few)
//     - Keyword / gemini-directed: take functions whose names overlap tokens
//     - Barrel-expansion / neighborhood: take first few exported functions
//     - No functions in index: include whole file (truncated)
//
//   What stays the same:
//     - fetchRawFileCached() — GitHub + Redis caching
//     - sliceFunctionBody() — line-based extraction
//     - semanticTruncate() — for pathologically large functions
// ─────────────────────────────────────────────────────────────────────────────

import type { RetrievalIndex, RetrievalFileEntry, RetrievalFunction } from "../models/retrieval";
import type { SearchIntent } from "./issueUnderstanding";
import type { CandidateFileEntry } from "./issueMapper";
import { fetchRawFile } from "../github/issueClient";
import { redisConnection } from "../queue/jobQueue";

// ── Output types ──────────────────────────────────────────────────────────────

/**
 * A code snippet ready for Gemini consumption.
 * Contains the actual function body sliced from the raw file.
 */
export interface CodeSnippet {
    /** Relative file path from repo root */
    fileId: string;
    /** Function name */
    functionName: string;
    /** Full function ID (filePath::functionName) */
    functionId: string;
    /** The actual source code of the function */
    body: string;
    /** Source lines range */
    startLine: number;
    endLine: number;
    /** Why this snippet was selected (for pipeline debugging) */
    selectionReasons: string[];
    /** How this file entered the candidate set */
    candidateSource: CandidateFileEntry["source"];
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum functions per file to include in snippets.
 *
 * 5 is the empirical sweet spot: enough to cover different call paths,
 * not so many that context is wasted.
 */
const MAX_FUNCTIONS_PER_FILE = 5;

/**
 * Pathological function threshold (lines).
 * Functions longer than this get semantic truncation applied.
 */
const HUGE_FUNCTION_LINES = 300;

/**
 * Redis TTL for raw file cache (1 hour).
 */
const RAW_FILE_CACHE_TTL_SECONDS = 3600;

/**
 * Maximum total snippets to send to Gemini.
 */
const MAX_TOTAL_SNIPPETS = 20;

/**
 * Emergency safety cap (lines). Any snippet exceeding this is hard-truncated.
 * This is NOT primary filtering — it's a final safety net for parser edge cases
 * where line numbers are wrong or files are unexpectedly huge.
 */
const MAX_SNIPPET_LINES = 1200;

// ── Token-based function selection ────────────────────────────────────────────

/**
 * Select functions from a file based on candidate source and token overlap.
 *
 * No scoring. No weighting. Simple rules per source type:
 *   - "pr": take exported functions first, then any (most prominent)
 *   - "keyword" / "gemini-directed": take functions whose names match tokens
 *   - "barrel-expansion" / "neighborhood": take first few exported functions
 *
 * @param functions  All functions in the file from RetrievalIndex
 * @param source     How this file entered the candidate set
 * @param tokens     Entity tokens from SearchIntent
 * @returns          Selected functions with selection reasons
 */
function selectFunctions(
    functions: RetrievalFunction[],
    source: CandidateFileEntry["source"],
    tokens: string[],
): Array<{ fn: RetrievalFunction; reasons: string[] }> {
    if (functions.length === 0) return [];

    switch (source) {
        case "pr": {
            // PR files: take exported functions first (entry points),
            // fall back to any functions if none are exported
            const exported = functions.filter(fn => fn.isExported);
            const selected = exported.length > 0
                ? exported.slice(0, MAX_FUNCTIONS_PER_FILE)
                : functions.slice(0, MAX_FUNCTIONS_PER_FILE);
            return selected.map(fn => ({
                fn,
                reasons: [`PR-sourced file, ${fn.isExported ? "exported" : "non-exported"} function`],
            }));
        }

        case "keyword":
        case "gemini-directed": {
            // Take functions whose names contain any token (substring match)
            const matched = functions.filter(fn => {
                const nameLower = fn.name.toLowerCase();
                return tokens.some(t => nameLower.includes(t));
            });

            if (matched.length > 0) {
                return matched.slice(0, MAX_FUNCTIONS_PER_FILE).map(fn => ({
                    fn,
                    reasons: [`function name matches issue tokens`],
                }));
            }

            // No name matches — take first few exported as representative sample
            const exported = functions.filter(fn => fn.isExported);
            return (exported.length > 0 ? exported : functions)
                .slice(0, 3)
                .map(fn => ({
                    fn,
                    reasons: [`representative sample (no direct name match)`],
                }));
        }

        case "barrel-expansion":
        case "neighborhood": {
            // Take first few exported functions as representative sample
            const exported = functions.filter(fn => fn.isExported);
            return (exported.length > 0 ? exported : functions)
                .slice(0, 3)
                .map(fn => ({
                    fn,
                    reasons: [`${source} — representative exported function`],
                }));
        }

        default:
            return functions.slice(0, 3).map(fn => ({
                fn,
                reasons: [`included from ${source}`],
            }));
    }
}

// ── Semantic truncation ───────────────────────────────────────────────────────

/**
 * Patterns that identify high-signal lines worth preserving in truncation.
 */
const HIGH_SIGNAL_LINE_PATTERNS = [
    /\b(checkAuth|requireAuth|verifyAuth|isAuthenticated|hasPermission|checkPermission|requireRole)\s*\(/i,
    /\b(context|ctx|req)\.(user|currentUser|viewer)\b/i,
    /throw\s+new\s+\w*(Unauthorized|Forbidden|AuthorizationError|AccessDenied)/i,
    /\.(findOne|findMany|findFirst|findAll|findById|findUnique|create|createMany|save|update|upsert|delete|deleteOne|deleteMany|destroy|insert)\s*\(/i,
    /\b(db|pool|client|prisma|repository)\.(select|insert|update|delete|query)\s*\(/i,
    /throw\s+new\s+\w*Error/i,
    /throw\s+new\s+\w*Exception/i,
    /^\s*return\s+/,
    /\bawait\s+\w/,
];

/**
 * Patterns that identify low-signal lines safe to drop in truncation.
 */
const LOW_SIGNAL_LINE_PATTERNS = [
    /^\s*\/\//,
    /^\s*\*\s/,
    /^\s*\/\*/,
    /^\s*\*\//,
    /^\s*$/,
    /^\s*console\.(log|debug|warn|info)\s*\(/,
];

function isHighSignal(line: string): boolean {
    return HIGH_SIGNAL_LINE_PATTERNS.some(p => p.test(line));
}

function isLowSignal(line: string): boolean {
    return LOW_SIGNAL_LINE_PATTERNS.some(p => p.test(line));
}

/**
 * Semantic-aware truncation for pathologically large functions.
 *
 * Strategy:
 *   1. Always keep first 10 lines (signature + early logic)
 *   2. Always keep last 10 lines (return values + closing)
 *   3. From middle: keep high-signal lines + 2-line context
 *   4. Drop low-signal lines
 *   5. Insert omission markers at cut points
 */
function semanticTruncate(body: string): string {
    const lines = body.split("\n");
    if (lines.length <= HUGE_FUNCTION_LINES) return body;

    const HEAD_LINES = 10;
    const TAIL_LINES = 10;
    const CONTEXT_AROUND_HIGH_SIGNAL = 2;

    const head = lines.slice(0, HEAD_LINES);
    const tail = lines.slice(-TAIL_LINES);
    const middle = lines.slice(HEAD_LINES, lines.length - TAIL_LINES);

    const keepIndices = new Set<number>();
    for (let i = 0; i < middle.length; i++) {
        if (isHighSignal(middle[i])) {
            for (let j = Math.max(0, i - CONTEXT_AROUND_HIGH_SIGNAL);
                j <= Math.min(middle.length - 1, i + CONTEXT_AROUND_HIGH_SIGNAL);
                j++) {
                keepIndices.add(j);
            }
        }
    }

    const truncatedMiddle: string[] = [];
    let lastKept = -1;

    const sortedIndices = [...keepIndices].sort((a, b) => a - b);
    for (const idx of sortedIndices) {
        if (isLowSignal(middle[idx])) continue;

        if (lastKept !== -1 && idx > lastKept + 1) {
            const omitted = idx - lastKept - 1;
            truncatedMiddle.push(`  // ... [${omitted} lines omitted] ...`);
        }

        truncatedMiddle.push(middle[idx]);
        lastKept = idx;
    }

    if (keepIndices.size < middle.length) {
        const remaining = middle.length - (lastKept + 1);
        if (remaining > 0) {
            truncatedMiddle.push(`  // ... [${remaining} more lines omitted] ...`);
        }
    }

    return [...head, ...truncatedMiddle, ...tail].join("\n");
}

// ── Raw file caching ──────────────────────────────────────────────────────────

/**
 * Fetch a raw file from GitHub with Redis caching.
 *
 * Cache key: rawfile:{owner}:{repo}:{sha}:{fileId}
 * TTL: RAW_FILE_CACHE_TTL_SECONDS (1 hour)
 */
async function fetchRawFileCached(
    owner: string,
    repo: string,
    commitSha: string,
    fileId: string,
): Promise<string> {
    const safeFileId = fileId.replace(/[/\\]/g, ":");
    const cacheKey = `rawfile:${owner}:${repo}:${commitSha}:${safeFileId}`;

    try {
        const cached = await redisConnection.get(cacheKey);
        if (cached) {
            console.log(`\x1b[36m[snippetFetcher] cache hit: ${fileId}\x1b[0m`);
            return cached;
        }
    } catch {
        // Redis failure is non-fatal
    }

    const content = await fetchRawFile(owner, repo, commitSha, fileId);

    if (content) {
        try {
            await redisConnection.set(cacheKey, content, "EX", RAW_FILE_CACHE_TTL_SECONDS);
        } catch {
            // Cache write failure is never fatal
        }
    }

    return content;
}

/**
 * Slice a function body from raw file content using line numbers.
 * Line numbers from ts-morph are 1-indexed.
 */
function sliceFunctionBody(
    rawContent: string,
    startLine: number,
    endLine: number,
): string {
    const lines = rawContent.split("\n");
    const start = Math.max(0, startLine - 1);
    const end = Math.min(lines.length, endLine);
    return lines.slice(start, end).join("\n");
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Select functions from candidate files and fetch their code bodies.
 *
 * Phase A (Selection — no I/O):
 *   Select functions using token overlap and source-based rules.
 *   No scoring. No threshold filtering.
 *
 * Phase B (Fetching — GitHub API, Redis cached):
 *   Fetch raw file content for each surviving file (once per file).
 *   Slice function bodies using line numbers.
 *   Apply semantic truncation to huge functions.
 *
 * @param candidates   Candidate files from issueMapper.traverseGraph()
 * @param retrieval    RetrievalIndex for function metadata
 * @param intent       SearchIntent for token-based function selection
 * @param owner        GitHub repo owner
 * @param repo         GitHub repo name
 * @param commitSha    Commit SHA for raw file fetching
 * @returns            Code snippets ready for Gemini
 */
export async function fetchSnippets(
    candidates: CandidateFileEntry[],
    retrieval: RetrievalIndex,
    intent: SearchIntent,
    owner: string,
    repo: string,
    commitSha: string,
): Promise<CodeSnippet[]> {
    // Build file map for O(1) lookup
    const fileMap = new Map<string, RetrievalFileEntry>();
    for (const f of retrieval.files) {
        fileMap.set(f.fileId, f);
    }

    const tokens = intent.entities;

    // ── Phase A: Function selection ───────────────────────────────────────────

    interface SelectedFile {
        candidateEntry: CandidateFileEntry;
        selectedFunctions: Array<{ fn: RetrievalFunction; reasons: string[] }>;
        /** Indicates how to handle files with 0 selected functions */
        zeroFunctionMode?: "pr-no-metadata" | "structure-pr-partial" | "zero-pr-partial";
    }

    const selectedFiles: SelectedFile[] = [];

    for (const candidate of candidates) {
        const fileEntry = fileMap.get(candidate.fileId);



        if (fileEntry?.isBarrel === true) {
            console.log(`\x1b[33m[snippetFetcher] dropping ${candidate.fileId} — barrel (isBarrel=true)\x1b[0m`);
            continue;
        }

        if (!fileEntry) {

            if (candidate.source === "pr") {
                selectedFiles.push({ candidateEntry: candidate, selectedFunctions: [], zeroFunctionMode: "pr-no-metadata" });
            }
            continue;
        }

        const looksLikeBarrel = fileEntry.functions.length === 0
            && (fileEntry.structures?.length ?? 0) === 0
            && fileEntry.imports.length > 0;

        if (looksLikeBarrel) {
            console.log(`\x1b[33m[snippetFetcher] dropping ${candidate.fileId} — structural barrel (0 fns, 0 structs, has imports)\x1b[0m`);
            continue;
        }

        // ── Zero-function handling ─────────────────────────────────────────────
        if (fileEntry.functions.length === 0) {
            const structCount = fileEntry.structures?.length ?? 0;

            if (structCount > 0) {
                // CASE A — Structure-only file (types, interfaces, enums, consts)
                if (candidate.source === "pr") {
                    // PR-linked structure file: keep a tiny preview (first 40-80 lines)
                    console.log(`\x1b[33m[snippetFetcher] structure-only PR file — partial fetch ${candidate.fileId}\x1b[0m`);
                    selectedFiles.push({ candidateEntry: candidate, selectedFunctions: [], zeroFunctionMode: "structure-pr-partial" });
                } else {
                    // Non-PR structure-only: drop entirely
                    console.log(`\x1b[33m[snippetFetcher] dropping ${candidate.fileId} — structure-only file (${structCount} structures)\x1b[0m`);
                }
            } else {
                // CASE B — True zero-content file (no functions, no structures)
                if (candidate.source === "pr") {
                    // PR-sourced: keep partial preview
                    console.log(`\x1b[33m[snippetFetcher] partial PR fallback fetch ${candidate.fileId}\x1b[0m`);
                    selectedFiles.push({ candidateEntry: candidate, selectedFunctions: [], zeroFunctionMode: "zero-pr-partial" });
                } else {
                    // Non-PR zero-content: drop if large, keep partial if small
                    // lineCount is not on RetrievalFileEntry — estimate from structures
                    console.log(`\x1b[33m[snippetFetcher] dropping ${candidate.fileId} — empty file (0 functions, 0 structures)\x1b[0m`);
                }
            }
            continue;
        }

        const selected = selectFunctions(fileEntry.functions, candidate.source, tokens);
        selectedFiles.push({ candidateEntry: candidate, selectedFunctions: selected });
    }

    // ── Phase B: Fetch file content and slice bodies ──────────────────────────

    const snippets: CodeSnippet[] = [];
    const fetchedContent = new Map<string, string>();

    for (const { candidateEntry, selectedFunctions } of selectedFiles) {
        if (snippets.length >= MAX_TOTAL_SNIPPETS) break;

        const { fileId, source } = candidateEntry;

        // Fetch raw file content (once per file, Redis-cached)
        let rawContent = fetchedContent.get(fileId);
        if (rawContent === undefined) {
            try {
                rawContent = await fetchRawFileCached(owner, repo, commitSha, fileId);
                fetchedContent.set(fileId, rawContent);
            } catch (err) {
                console.warn(`\x1b[31m[snippetFetcher] failed to fetch ${fileId}:\x1b[0m`, (err as Error).message);
                continue;
            }
        }

        if (!rawContent) continue;

        // ── Zero-function modes: controlled partial fetch ──────────────────
        if (selectedFunctions.length === 0) {
            const lines = rawContent.split("\n");
            const { zeroFunctionMode } = selectedFiles.find(sf => sf.candidateEntry.fileId === fileId)!;

            // Determine how many lines to preview based on mode
            let previewLines: number;
            let reason: string;

            switch (zeroFunctionMode) {
                case "structure-pr-partial":
                    previewLines = Math.min(80, lines.length);
                    reason = "PR-sourced structure-only file (partial preview)";
                    break;
                case "zero-pr-partial":
                    previewLines = Math.min(80, lines.length);
                    reason = "PR-sourced zero-content file (partial preview)";
                    break;
                case "pr-no-metadata":
                default:
                    previewLines = Math.min(80, lines.length);
                    reason = "PR-sourced file (no function metadata, partial preview)";
                    break;
            }

            const body = lines.slice(0, previewLines).join("\n")
                + (lines.length > previewLines ? `\n// ... [${lines.length - previewLines} more lines omitted] ...` : "");

            snippets.push({
                fileId,
                functionName: "(partial file)",
                functionId: `${fileId}::*`,
                body,
                startLine: 1,
                endLine: previewLines,
                selectionReasons: [reason],
                candidateSource: source,
            });
            continue;
        }

        // Slice individual function bodies
        for (const { fn, reasons } of selectedFunctions) {
            if (snippets.length >= MAX_TOTAL_SNIPPETS) break;

            let rawBody = sliceFunctionBody(rawContent, fn.startLine, fn.endLine);

            // Emergency safety cap — hard-truncate if parser line numbers are wrong
            const rawLines = rawBody.split("\n");
            if (rawLines.length > MAX_SNIPPET_LINES) {
                console.warn(`\x1b[31m[snippetFetcher] truncating oversized snippet ${fileId}::${fn.name} (${rawLines.length} lines → ${MAX_SNIPPET_LINES})\x1b[0m`);
                rawBody = rawLines.slice(0, MAX_SNIPPET_LINES).join("\n") + `\n// ... [truncated at ${MAX_SNIPPET_LINES} lines] ...`;
            }

            const body = semanticTruncate(rawBody);

            snippets.push({
                fileId,
                functionName: fn.name,
                functionId: fn.id,
                body,
                startLine: fn.startLine,
                endLine: fn.endLine,
                selectionReasons: reasons,
                candidateSource: source,
            });
        }
    }

    console.log(
        `\x1b[32m[snippetFetcher] selected ${snippets.length} snippets from ` +
        `${selectedFiles.length}/${candidates.length} candidate files\x1b[0m`
    );

    return snippets;
}
