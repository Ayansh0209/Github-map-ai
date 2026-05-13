// src/parser/snippetFetcher.ts
// ─────────────────────────────────────────────────────────────────────────────
// Bridges candidate file IDs → actual code bodies for Gemini to reason over.
//
// Two-phase approach:
//   Phase A — Selection (metadata only, no GitHub fetch):
//     Score each function in each candidate file against the SearchIntent.
//     Drop files whose functions score below threshold.
//     This is the main scope-narrowing step — only functions Gemini needs.
//
//   Phase B — Fetching (GitHub raw content API):
//     Group selected functions by fileId.
//     For each unique fileId, fetch the raw file once (cached in Redis, 1h TTL).
//     Slice function bodies using startLine/endLine from RetrievalFunction.
//
// Redis caching:
//   key: rawfile:{owner}:{repo}:{sha}:{fileId}  (TTL: 3600 seconds)
//   This ensures the same file is fetched only once per analysis session,
//   even if multiple issue mapping requests need it in parallel.
//
// Truncation strategy:
//   Normal functions: returned in full.
//   Pathological functions (> HUGE_FUNCTION_LINES): semantic-aware truncation
//   that preserves signature, auth logic, DB calls, thrown errors, and returns,
//   while dropping comment blocks, repetitive validation, low-signal branches.
// ─────────────────────────────────────────────────────────────────────────────

import type { RetrievalIndex, RetrievalFileEntry, RetrievalFunction } from "../models/retrieval";
import type { SearchIntent } from "./issueUnderstanding";
import { intentHasAuthSignal, intentHasDataSignal } from "./issueUnderstanding";
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
    /** Semantic signals that influenced selection */
    hasAuthCheck: boolean;
    hasDatabaseCall: boolean;
    /** How this file entered the candidate set */
    candidateSource: CandidateFileEntry["source"];
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Function selection score threshold.
 *
 * Reasoning: a function scoring 0 against the SearchIntent provides no
 * retrieval signal. We need at least score >= 2 to have confidence that
 * this function is related to the issue. Score of 1 alone (e.g. a single
 * concept match) produces too many false positives.
 *
 * Exception: functions in PR-sourced files always pass regardless of score —
 * PR files are the strongest external signal we have.
 */
const FUNCTION_SCORE_THRESHOLD = 2;

/**
 * File selection threshold: minimum number of functions above threshold
 * required to include a file.
 *
 * Reasoning: if no function in a file scores above threshold, the file
 * probably matched only via path/directory naming, not via actual code
 * relevance. Drop it entirely to reduce noise for Gemini.
 *
 * Exception: PR-sourced files and files with < 3 functions always pass
 * (small files deserve a chance even with weak signal).
 */
const MIN_FUNCTIONS_ABOVE_THRESHOLD_PER_FILE = 1;

/**
 * Maximum functions per file to include in snippets.
 *
 * Reasoning: sending every function in a large file would exhaust the
 * context window. Pick the top-scoring N functions per file.
 * 5 is the empirical sweet spot: enough to cover different call paths,
 * not so many that context is wasted.
 */
const MAX_FUNCTIONS_PER_FILE = 5;

/**
 * Pathological function threshold (lines).
 *
 * Functions longer than this are candidates for semantic truncation.
 * 300 lines is a safe threshold that catches:
 *   - Auto-generated code (GraphQL code-gen output)
 *   - Migration files with long SQL strings
 *   - Test fixtures with large inline data
 * while NOT truncating real business logic, which rarely exceeds 200 lines.
 */
const HUGE_FUNCTION_LINES = 300;

/**
 * Redis TTL for raw file cache (1 hour).
 *
 * Reasoning: 1 hour is long enough to serve multiple concurrent issue mapping
 * requests for the same file, but short enough that stale content doesn't
 * persist across different analysis sessions.
 */
const RAW_FILE_CACHE_TTL_SECONDS = 3600;

/**
 * Maximum total snippets to send to Gemini.
 *
 * Reasoning: Gemini 2.5 Pro has a 1M token context window, but sending 100
 * snippets is inefficient and expensive. We want the most relevant 20 snippets
 * to fit comfortably in the prompt alongside the issue text.
 */
const MAX_TOTAL_SNIPPETS = 20;

// ── Function scoring ──────────────────────────────────────────────────────────

interface ScoredFunction {
    fn: RetrievalFunction;
    score: number;
    reasons: string[];
}

/**
 * Score a single function against the SearchIntent.
 *
 * Signals used (in order of weight):
 *   1. Function name overlaps with intent entities/operations (+2 each)
 *   2. hasAuthCheck when intent has auth concepts (+4 — strong signal)
 *   3. hasDatabaseCall when intent has data operations (+4 — strong signal)
 *   4. isExported (+1 — exported functions are likely entry points)
 *   5. kind is resolver, route-handler, middleware, async (+2 each)
 */
function scoreFunctionAgainstIntent(
    fn: RetrievalFunction,
    intent: SearchIntent,
    intentHasAuth: boolean,
    intentHasData: boolean,
): ScoredFunction {
    let score = 0;
    const reasons: string[] = [];
    const nameLower = fn.name.toLowerCase();

    // Entity matches
    for (const entity of intent.entities) {
        if (nameLower.includes(entity.toLowerCase())) {
            score += 2;
            reasons.push(`name matches entity "${entity}"`);
        }
    }

    // Operation matches
    for (const op of intent.operations) {
        if (nameLower.includes(op.toLowerCase())) {
            score += 1;
            reasons.push(`name matches operation "${op}"`);
        }
    }

    // Auth signal boost — most valuable when issue is about permissions
    if (fn.hasAuthCheck && intentHasAuth) {
        score += 4;
        reasons.push("hasAuthCheck + intent has auth concepts");
    } else if (fn.hasAuthCheck) {
        // Still worth including even without explicit auth intent —
        // auth bugs often manifest as wrong behavior, not "permission denied"
        score += 1;
        reasons.push("hasAuthCheck (general signal)");
    }

    // Data signal boost — most valuable when issue is about data not saving/loading
    if (fn.hasDatabaseCall && intentHasData) {
        score += 4;
        reasons.push("hasDatabaseCall + intent has data operations");
    } else if (fn.hasDatabaseCall) {
        score += 1;
        reasons.push("hasDatabaseCall (general signal)");
    }

    // Exported functions are likely public API / entry points
    if (fn.isExported) {
        score += 1;
        reasons.push("isExported");
    }

    // High-signal function kinds
    if (fn.kind === "resolver" || fn.kind === "route-handler") {
        score += 2;
        reasons.push(`kind=${fn.kind}`);
    } else if (fn.kind === "middleware" || fn.kind === "async") {
        score += 1;
        reasons.push(`kind=${fn.kind}`);
    }

    return { fn, score, reasons };
}

// ── Semantic truncation ───────────────────────────────────────────────────────

/**
 * Patterns that identify high-signal lines worth preserving in truncation.
 *
 * These cover the lines that Gemini needs most:
 *   - Function signature (first line)
 *   - Auth/permission checks
 *   - Database calls
 *   - Error throws
 *   - Return statements
 */
const HIGH_SIGNAL_LINE_PATTERNS = [
    // Auth patterns
    /\b(checkAuth|requireAuth|verifyAuth|isAuthenticated|hasPermission|checkPermission|requireRole)\s*\(/i,
    /\b(context|ctx|req)\.(user|currentUser|viewer)\b/i,
    /throw\s+new\s+\w*(Unauthorized|Forbidden|AuthorizationError|AccessDenied)/i,
    // DB patterns
    /\.(findOne|findMany|findFirst|findAll|findById|findUnique|create|createMany|save|update|upsert|delete|deleteOne|deleteMany|destroy|insert)\s*\(/i,
    /\b(db|pool|client|prisma|repository)\.(select|insert|update|delete|query)\s*\(/i,
    // Error handling
    /throw\s+new\s+\w*Error/i,
    /throw\s+new\s+\w*Exception/i,
    // Return statements
    /^\s*return\s+/,
    // Awaited calls (often critical operations)
    /\bawait\s+\w/,
];

/**
 * Patterns that identify low-signal lines safe to drop in truncation.
 *
 * These are lines that consume vertical space but provide little
 * reasoning value for Gemini:
 *   - Comment blocks
 *   - Blank lines
 *   - Simple console.log statements
 *   - Import statements (already in context from file path)
 */
const LOW_SIGNAL_LINE_PATTERNS = [
    /^\s*\/\//,              // single-line comments
    /^\s*\*\s/,             // JSDoc/block comment lines
    /^\s*\/\*/,             // block comment start
    /^\s*\*\//,             // block comment end
    /^\s*$/,                // blank lines
    /^\s*console\.(log|debug|warn|info)\s*\(/,  // console statements
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
 *   1. Always keep the first 10 lines (function signature + early logic)
 *   2. Always keep the last 10 lines (return values + closing braces)
 *   3. From the middle: keep high-signal lines + their 2-line context
 *   4. Drop low-signal lines (comments, blank lines, console.log)
 *   5. Insert "... [N lines omitted] ..." markers at cut points
 *
 * This truncation is only applied to functions with HUGE_FUNCTION_LINES+ lines.
 * For normal functions (< 300 lines), the full body is always returned.
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

    // Find high-signal line indices in the middle section
    const keepIndices = new Set<number>();
    for (let i = 0; i < middle.length; i++) {
        if (isHighSignal(middle[i])) {
            // Keep this line and its context
            for (let j = Math.max(0, i - CONTEXT_AROUND_HIGH_SIGNAL);
                     j <= Math.min(middle.length - 1, i + CONTEXT_AROUND_HIGH_SIGNAL);
                     j++) {
                keepIndices.add(j);
            }
        }
    }

    // Build the truncated middle
    const truncatedMiddle: string[] = [];
    let lastKept = -1;

    const sortedIndices = [...keepIndices].sort((a, b) => a - b);
    for (const idx of sortedIndices) {
        if (isLowSignal(middle[idx])) continue; // drop low-signal even if in keep set

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
 *
 * Cache misses fall through to GitHub API. Cache failures (Redis down)
 * fall through to GitHub API without crashing.
 */
async function fetchRawFileCached(
    owner: string,
    repo: string,
    commitSha: string,
    fileId: string,
): Promise<string> {
    // Sanitize fileId for use in Redis key (replace slashes with colon)
    const safeFileId = fileId.replace(/[/\\]/g, ":");
    const cacheKey = `rawfile:${owner}:${repo}:${commitSha}:${safeFileId}`;

    // Try cache first
    try {
        const cached = await redisConnection.get(cacheKey);
        if (cached) {
            console.log(`[snippetFetcher] cache hit: ${fileId}`);
            return cached;
        }
    } catch {
        // Redis failure is non-fatal — fall through to GitHub
    }

    // Fetch from GitHub
    const content = await fetchRawFile(owner, repo, commitSha, fileId);

    // Write to cache (non-fatal if Redis is down)
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
 *
 * Line numbers from ts-morph are 1-indexed. We convert to 0-indexed for
 * array slicing. The slice is inclusive of both startLine and endLine.
 */
function sliceFunctionBody(
    rawContent: string,
    startLine: number,
    endLine: number,
): string {
    const lines = rawContent.split("\n");
    // ts-morph line numbers are 1-indexed, Array.slice is 0-indexed
    const start = Math.max(0, startLine - 1);
    const end   = Math.min(lines.length, endLine); // slice end is exclusive
    return lines.slice(start, end).join("\n");
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Select functions from candidate files and fetch their code bodies.
 *
 * Phase A (Selection — no I/O):
 *   Score functions against SearchIntent.
 *   Drop files with no functions above threshold (except PR files).
 *
 * Phase B (Fetching — GitHub API, Redis cached):
 *   Fetch raw file content for each surviving file (once per file).
 *   Slice function bodies using line numbers.
 *   Apply semantic truncation to huge functions.
 *
 * @param candidates   Candidate files from issueMapper.traverseGraph()
 * @param retrieval    RetrievalIndex for function metadata
 * @param intent       Structured search intent for function scoring
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

    const intentHasAuth = intentHasAuthSignal(intent);
    const intentHasData = intentHasDataSignal(intent);

    // ── Phase A: Function selection ───────────────────────────────────────────

    // For each candidate file, score its functions
    interface SelectedFile {
        candidateEntry: CandidateFileEntry;
        selectedFunctions: ScoredFunction[];
    }

    const selectedFiles: SelectedFile[] = [];

    for (const candidate of candidates) {
        const fileEntry = fileMap.get(candidate.fileId);
        if (!fileEntry) {
            // File not in retrieval index — still include it if it came from a PR
            // but we can't select functions without metadata
            if (candidate.source === "pr") {
                selectedFiles.push({ candidateEntry: candidate, selectedFunctions: [] });
            }
            continue;
        }

        // Score all functions in this file
        const scored: ScoredFunction[] = fileEntry.functions
            .map(fn => scoreFunctionAgainstIntent(fn, intent, intentHasAuth, intentHasData))
            .sort((a, b) => b.score - a.score);

        // Determine if this file passes the threshold
        const aboveThreshold = scored.filter(s => s.score >= FUNCTION_SCORE_THRESHOLD);

        const passes =
            candidate.source === "pr" ||                             // PR files always pass
            aboveThreshold.length >= MIN_FUNCTIONS_ABOVE_THRESHOLD_PER_FILE ||
            (fileEntry.functions.length < 3 && scored[0]?.score > 0); // Small files get a pass

        if (!passes) {
            console.log(`[snippetFetcher] dropping ${candidate.fileId} — no functions above threshold`);
            continue;
        }

        // Take top N functions per file (PR files: take all above 0 score, or all if no score)
        let toFetch: ScoredFunction[];
        if (candidate.source === "pr") {
            toFetch = scored.filter(s => s.score >= 0).slice(0, MAX_FUNCTIONS_PER_FILE);
        } else {
            toFetch = aboveThreshold.slice(0, MAX_FUNCTIONS_PER_FILE);
        }

        selectedFiles.push({ candidateEntry: candidate, selectedFunctions: toFetch });
    }

    // ── Phase B: Fetch file content and slice bodies ──────────────────────────

    const snippets: CodeSnippet[] = [];
    const fetchedContent = new Map<string, string>(); // fileId → raw content

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
                console.warn(`[snippetFetcher] failed to fetch ${fileId}:`, (err as Error).message);
                continue;
            }
        }

        if (!rawContent) continue;

        // If no functions were selected (e.g. PR file not in retrieval index),
        // include the whole file truncated to HUGE_FUNCTION_LINES lines
        if (selectedFunctions.length === 0) {
            const lines = rawContent.split("\n");
            const body = lines.length > HUGE_FUNCTION_LINES
                ? lines.slice(0, HUGE_FUNCTION_LINES).join("\n") + `\n// ... [${lines.length - HUGE_FUNCTION_LINES} more lines omitted] ...`
                : rawContent;

            snippets.push({
                fileId,
                functionName: "(entire file)",
                functionId: `${fileId}::*`,
                body,
                startLine: 1,
                endLine: lines.length,
                selectionReasons: ["PR-sourced file (no function metadata available)"],
                hasAuthCheck: false,
                hasDatabaseCall: false,
                candidateSource: source,
            });
            continue;
        }

        // Slice individual function bodies
        for (const { fn, score, reasons } of selectedFunctions) {
            if (snippets.length >= MAX_TOTAL_SNIPPETS) break;

            const rawBody = sliceFunctionBody(rawContent, fn.startLine, fn.endLine);
            const body = semanticTruncate(rawBody);

            snippets.push({
                fileId,
                functionName: fn.name,
                functionId: fn.id,
                body,
                startLine: fn.startLine,
                endLine: fn.endLine,
                selectionReasons: reasons,
                hasAuthCheck: fn.hasAuthCheck,
                hasDatabaseCall: fn.hasDatabaseCall,
                candidateSource: source,
            });
        }
    }

    console.log(
        `[snippetFetcher] selected ${snippets.length} snippets from ` +
        `${selectedFiles.length}/${candidates.length} candidate files`
    );

    return snippets;
}
