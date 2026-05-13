// src/parser/issuePipeline.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pipeline orchestrator for the Phase 2 issue mapping system.
//
// This module owns the end-to-end flow and nothing else.
// It calls each stage in order, handles the two routing paths (specific vs
// vague issues), and degrades gracefully when any stage fails.
//
// ROUTING LOGIC:
//   Specific issue path (default):
//     1. IssueUnderstanding → SearchIntent (deterministic)
//     2. IssueMapper → candidate fileIds (graph traversal)
//     3. SnippetFetcher → actual code snippets (GitHub fetch + Redis cache)
//     4. callGeminiForMapping → affected files with reasoning
//
//   Vague issue path (SearchIntent.isVague === true):
//     1. IssueUnderstanding → SearchIntent (marked isVague)
//     2. First Gemini call: reads issue → extracts domain intent as text
//     3. Feed extracted domain back into IssueUnderstanding to enrich SearchIntent
//     4. Continue with steps 2-4 of specific path
//
//   PR fast path (linkedPRs with changedFiles):
//     PR files are injected as "pr" source candidates by the mapper.
//     The snippet fetcher always includes PR-sourced files regardless of score.
//     This is automatic — no special routing needed.
//
// GRACEFUL DEGRADATION:
//   If the RetrievalIndex is missing in Redis → mapper falls back to inline search
//   If snippetFetcher fails → pass empty snippets array to Gemini
//   If Gemini fails → return the deterministic mapper results as-is
//   If the entire new pipeline fails → fall back to the old behavior
//
// WHAT THIS FILE DOES NOT DO:
//   - No business logic (that lives in understanding/mapper/fetcher/analyzer)
//   - No Redis reads/writes (that lives in the individual stages)
//   - No route handling (that lives in routes/issueMap.ts, untouched in Phase 2)
// ─────────────────────────────────────────────────────────────────────────────

import { extractSearchIntent } from "./issueUnderstanding";
import type { SearchIntent } from "./issueUnderstanding";
import { traverseGraph } from "./issueMapper";
import type { CandidateSet } from "./issueMapper";
import { fetchSnippets } from "./snippetFetcher";
import type { CodeSnippet } from "./snippetFetcher";

import {
    callGeminiForMapping,
    type GeminiMappingResult,
    type IssueContextInput,
    type AffectedFile,
} from "./issueAnalyzer";
import type { RetrievalIndex } from "../models/retrieval";
import type { LinkedPR } from "../github/issueClient";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config/config";
import { redisConnection } from "../queue/jobQueue";

// ── Types ─────────────────────────────────────────────────────────────────────

/** All inputs the pipeline needs to execute */
export interface PipelineInput {
    /** GitHub repo owner */
    owner: string;
    /** GitHub repo name */
    repo: string;
    /** Commit SHA from the most recent analysis */
    commitSha: string;
    /** Full issue context */
    issue: IssueContextInput;
    /** Linked pull requests (may be empty) */
    linkedPRs: LinkedPR[];
    /**
     * All file IDs in the visualization graph (for filtering candidates).
     * These are the files the parser has seen — we only map to files we know about.
     */
    graphFileIds: Set<string>;
    /**
     * Inline files for legacy fallback (sent by the route handler from the
     * request body — these existed before the RetrievalIndex was built).
     */
    legacyFiles?: Array<{ id: string; label: string; architecturalImportance?: number }>;
}

/** The complete output of the pipeline */
export interface PipelineResult {
    /** The AI mapping result (or null if Gemini failed) */
    geminiResult: GeminiMappingResult | null;
    /**
     * Whether the new pipeline (RetrievalIndex + snippets) was used.
     * false = fell back to old behavior (inline search + filenames)
     */
    usedNewPipeline: boolean;
    /** Number of code snippets passed to Gemini (for debugging/logging) */
    snippetCount: number;
    /** Whether the issue was classified as vague */
    isVague: boolean;
    /** The extracted search intent (for logging and frontend display) */
    intent: SearchIntent | null;
    /** Deterministic fallback files (returned if Gemini fails or returns 0 results) */
    fallbackFiles: AffectedFile[];
}

// ── Vague issue: AI-assisted intent enrichment ────────────────────────────────

/**
 * For vague issues, ask Gemini to extract domain intent from the issue text
 * before running graph traversal.
 *
 * This is a lightweight "meta-AI" call — not the main mapping call.
 * We ask Gemini to identify:
 *   - What domain this issue is about
 *   - Key entities and operations
 *
 * The response is a plain string that we feed back into extractSearchIntent
 * to enrich the SearchIntent with AI-identified terms.
 *
 * Why this approach:
 *   - Keeps the SearchIntent type consistent (no special vague path later)
 *   - The same graph traversal and snippet fetching works for both paths
 *   - The AI reads the issue properly first, preventing keyword-noise traversal
 */
async function enrichIntentWithAI(issue: IssueContextInput): Promise<string> {
    if (!config.gemini.apiKey) return "";

    try {
        const client = new GoogleGenerativeAI(config.gemini.apiKey);
        const model = client.getGenerativeModel({
            model: "gemini-2.5-pro",
            generationConfig: { temperature: 0.1 },
        });

        const prompt = `You are analyzing a software issue to identify the domain context.

Issue title: ${issue.title}
Issue body: ${issue.body.slice(0, 1000)}
${issue.comments.length > 0 ? `\nComments: ${issue.comments.slice(0, 3).map(c => c.body.slice(0, 200)).join(" | ")}` : ""}

The issue description is vague. Identify the most specific domain concepts:
- What is this issue REALLY about? (in 3-5 concrete technical terms)
- What operations are involved? (create, update, delete, fetch, etc.)
- What data or UI elements are affected?

Respond with a single sentence of space-separated technical keywords only.
Example: "event agenda createAgendaItem updateAgendaItem creator permission"
Do not explain, just output keywords.`;

        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        console.log(`[issuePipeline] AI-enriched intent for vague issue: "${text.slice(0, 100)}"`);
        return text;
    } catch (err) {
        console.warn("[issuePipeline] AI intent enrichment failed:", (err as Error).message);
        return "";
    }
}

// ── RetrievalIndex loader ─────────────────────────────────────────────────────

/**
 * Load the RetrievalIndex from Redis.
 *
 * Returns null if:
 *   - Redis is unavailable
 *   - The key doesn't exist (repo analyzed before Phase 1 shipped)
 *   - The stored JSON is malformed
 *
 * All failures are non-fatal — the pipeline falls back gracefully.
 */
async function loadRetrievalIndex(owner: string, repo: string): Promise<RetrievalIndex | null> {
    try {
        const key = `retrieval:${owner}:${repo}`;
        const raw = await redisConnection.get(key);
        if (!raw) {
            console.log(`\x1b[33m[issuePipeline] no retrieval index in Redis for ${owner}/${repo} — using fallback\x1b[0m`);
            return null;
        }
        const index = JSON.parse(raw) as RetrievalIndex;
        console.log(`\x1b[32m[issuePipeline] loaded retrieval index: ${index.files.length} files\x1b[0m`);
        return index;
    } catch (err) {
        console.warn("\x1b[31m[issuePipeline] failed to load retrieval index:\x1b[0m", (err as Error).message);
        return null;
    }
}

// ── New pipeline path (uses RetrievalIndex + real code) ──────────────────────

/**
 * Execute the full Phase 2 pipeline:
 *   Intent extraction → Graph traversal → Snippet fetching → Gemini reasoning
 *
 * This is the "happy path" — called when the RetrievalIndex is available.
 */
async function runNewPipeline(
    input: PipelineInput,
    retrieval: RetrievalIndex,
    intent: SearchIntent,
): Promise<{ geminiResult: GeminiMappingResult | null; snippetCount: number }> {
    // ── Stage 2: Graph traversal ──────────────────────────────────────────────
    let candidates: CandidateSet;
    try {
        candidates = traverseGraph(intent, retrieval, input.linkedPRs, input.graphFileIds);
        console.log(
            `\x1b[34m[issuePipeline] graph traversal found ${candidates.files.length} candidates ` +
            `(${candidates.files.filter(f => f.source === "pr").length} from PRs)\x1b[0m`
        );
        console.log(`\x1b[36m[issuePipeline] CANDIDATE FILES:\n${candidates.files.map(c => `  - [${c.source}] ${c.fileId}`).join("\n")}\x1b[0m`);
    } catch (err) {
        console.warn("\x1b[31m[issuePipeline] graph traversal failed:\x1b[0m", (err as Error).message);
        return { geminiResult: null, snippetCount: 0 };
    }

    if (candidates.files.length === 0) {
        console.warn("\x1b[33m[issuePipeline] no candidates found — returning null\x1b[0m");
        return { geminiResult: null, snippetCount: 0 };
    }

    // ── Stage 3: Snippet fetching ─────────────────────────────────────────────
    let snippets: CodeSnippet[] = [];
    try {
        snippets = await fetchSnippets(
            candidates.files,
            retrieval,
            intent,
            input.owner,
            input.repo,
            input.commitSha,
        );
        console.log(`\x1b[32m[issuePipeline] fetched ${snippets.length} snippets\x1b[0m`);
    } catch (err) {
        console.warn("\x1b[31m[issuePipeline] snippet fetching failed:\x1b[0m", (err as Error).message);
        // Non-fatal — proceed with empty snippets (Gemini will still see the issue text)
    }

    // ── Stage 4: Gemini reasoning ─────────────────────────────────────────────
    let geminiResult: GeminiMappingResult | null = null;
    try {
        geminiResult = await callGeminiForMapping(input.issue, snippets, input.linkedPRs);
        if (geminiResult && geminiResult.affectedFiles.length > 0) {
            console.log(`\x1b[35m[issuePipeline] AI RETURNED FILES:\n${geminiResult.affectedFiles.map(f => `  - ${f.fileId} (confidence: ${f.confidence})`).join("\n")}\x1b[0m`);
        } else {
            console.log(`\x1b[31m[issuePipeline] AI RETURNED 0 FILES\x1b[0m`);
        }
    } catch (err) {
        console.warn("\x1b[31m[issuePipeline] Gemini mapping failed:\x1b[0m", (err as Error).message);
    }

    return { geminiResult, snippetCount: snippets.length };
}

// ── Legacy fallback path ──────────────────────────────────────────────────────

/**
 * Execute the legacy pipeline (Phase 1 behavior).
 * Used when RetrievalIndex is not available.
 *
 * @deprecated This path exists for backward compatibility only.
 * It sends filenames to Gemini rather than code snippets.
 */
async function runLegacyPipeline(
    input: PipelineInput,
): Promise<{ geminiResult: GeminiMappingResult | null; snippetCount: number }> {
    console.log("\x1b[33m[issuePipeline] using legacy pipeline (no retrieval index)\x1b[0m");

    const geminiResult = await callGeminiForMapping(
        input.issue,
        [], // no snippets available in legacy path
        input.linkedPRs,
    );

    return { geminiResult, snippetCount: 0 };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the complete issue mapping pipeline.
 *
 * This is the single entry point called by the route handler.
 * The route handler (routes/issueMap.ts) is untouched in Phase 2.
 *
 * Flow:
 *   1. Load RetrievalIndex from Redis
 *   2. If available → run new pipeline
 *   3. If not → run legacy pipeline for backward compat
 *   4. Return PipelineResult to the route handler
 *
 * @param input    All inputs needed for the pipeline
 * @returns        PipelineResult with Gemini output and diagnostic metadata
 */
export async function runIssueMappingPipeline(
    input: PipelineInput,
): Promise<PipelineResult> {
    // We compute this ALWAYS, so that if Gemini fails or returns 0 files,
    // we return an empty array because we removed the deterministic engine dependency.
    let fallbackFiles: AffectedFile[] = [];

    // ── Stage 1: Intent extraction ────────────────────────────────────────────
    const commentBodies = input.issue.comments.map(c => c.body);
    let intent = extractSearchIntent(input.issue.title, input.issue.body, commentBodies);

    console.log(
        `\x1b[32m[issuePipeline] intent extracted — ` +
        `entities: ${intent.entities.slice(0, 5).join(", ")}, ` +
        `isVague: ${intent.isVague}\x1b[0m`
    );

    // ── Stage 1b: Vague issue path — AI-assisted intent enrichment ────────────
    if (intent.isVague) {
        console.log("[issuePipeline] issue is vague — enriching intent with AI");
        const aiKeywords = await enrichIntentWithAI(input.issue);
        if (aiKeywords) {
            // Re-run intent extraction with AI keywords appended to the body
            intent = extractSearchIntent(
                input.issue.title,
                input.issue.body + "\n\n" + aiKeywords,
                commentBodies,
            );
            // Even if still "vague" after enrichment, the extra keywords help traversal
            console.log(
                `[issuePipeline] enriched intent — entities: ${intent.entities.slice(0, 5).join(", ")}`
            );
        }
    }

    // ── Load RetrievalIndex ───────────────────────────────────────────────────
    const retrieval = await loadRetrievalIndex(input.owner, input.repo);

    if (!retrieval) {
        // No retrieval index — use legacy pipeline
        const { geminiResult, snippetCount } = await runLegacyPipeline(input);
        return {
            geminiResult,
            usedNewPipeline: false,
            snippetCount,
            isVague: intent.isVague,
            intent,
            fallbackFiles,
        };
    }

    // ── Run new pipeline ──────────────────────────────────────────────────────
    try {
        const { geminiResult, snippetCount } = await runNewPipeline(input, retrieval, intent);
        return {
            geminiResult,
            usedNewPipeline: true,
            snippetCount,
            isVague: intent.isVague,
            intent,
            fallbackFiles,
        };
    } catch (err) {
        // Unexpected failure in new pipeline — degrade to legacy
        console.error(
            "[issuePipeline] new pipeline threw unexpectedly, falling back to legacy:",
            (err as Error).message
        );
        const { geminiResult, snippetCount } = await runLegacyPipeline(input);
        return {
            geminiResult,
            usedNewPipeline: false,
            snippetCount,
            isVague: intent.isVague,
            intent,
            fallbackFiles,
        };
    }
}
