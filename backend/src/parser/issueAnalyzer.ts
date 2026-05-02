// src/parser/issueAnalyzer.ts
// ─────────────────────────────────────────────────────────────────────────────
// All AI prompt engineering and analysis logic for issue mapping.
//
// No HTTP calls. No Redis. Pure input → output functions.
//
// Functions:
//   buildIssueContext()     — builds structured context string for Gemini
//   callGeminiForMapping()  — calls Gemini 2.0 Flash, returns affected files
//   callGeminiForFix()      — Phase 2 stub: suggest code fix for a specific file
// ─────────────────────────────────────────────────────────────────────────────

import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config/config";
import type { IssueComment } from "../github/issueClient";

// ── Shared types ──────────────────────────────────────────────────────────────

export interface AffectedFile {
    fileId: string;
    confidence: number;  // 0-100
    reason: string;      // one sentence
}

export interface GeminiMappingResult {
    affectedFiles: AffectedFile[];
    summary: string;
}

export interface GeminiFixResult {
    explanation: string;
    replacementBlocks: Array<{ original: string; replacement: string }>;
}

// Input shape for buildIssueContext
export interface IssueContextInput {
    title: string;
    body: string;
    comments: IssueComment[];
}

// ── Gemini client (lazy singleton) ────────────────────────────────────────────

let geminiClient: GoogleGenerativeAI | null = null;

function getGeminiClient(): GoogleGenerativeAI | null {
    if (!config.gemini.apiKey) return null;
    if (!geminiClient) geminiClient = new GoogleGenerativeAI(config.gemini.apiKey);
    return geminiClient;
}

// ── buildIssueContext ─────────────────────────────────────────────────────────

/**
 * Builds the structured context string to send to Gemini.
 *
 * - issue: the issue title, body, and fetched comments
 * - relevantFiles: top candidates from deterministic matching (max 10)
 * - fileContents: actual source code for top 3 files only
 *     - Truncated: first 100 lines + last 50 lines if file > 200 lines
 *     - Full content if ≤ 200 lines
 *
 * Returns a structured string — never a raw dump.
 */
export function buildIssueContext(
    issue: IssueContextInput,
    relevantFiles: Array<{ fileId: string; confidence: number; reason: string }>,
    fileContents: Map<string, string>,
): string {
    const parts: string[] = [];

    // Issue body
    parts.push(`ISSUE: ${issue.title}`);
    parts.push(`\nDESCRIPTION:\n${issue.body.slice(0, 800)}`);

    // Comments (up to 3, 200 chars each)
    if (issue.comments.length > 0) {
        const commentText = issue.comments
            .slice(0, 3)
            .map(c => `[${c.author}]: ${c.body.slice(0, 200)}`)
            .join("\n---\n");
        parts.push(`\nDISCUSSION (${issue.comments.length} comments):\n${commentText}`);
    }

    // Deterministic candidates (context only)
    if (relevantFiles.length > 0) {
        const candidateLines = relevantFiles
            .slice(0, 10)
            .map(f => `  ${f.fileId} (confidence: ${f.confidence}% — ${f.reason})`);
        parts.push(`\nDETERMINISTIC CANDIDATES:\n${candidateLines.join("\n")}`);
    }

    // Relevant source code (top 3 files only)
    const topFiles = relevantFiles.slice(0, 3);
    const codeSnippets: string[] = [];

    for (const file of topFiles) {
        const content = fileContents.get(file.fileId);
        if (!content) continue;

        const lines = content.split("\n");
        let snippet: string;

        if (lines.length <= 200) {
            snippet = content;
        } else {
            const head = lines.slice(0, 100).join("\n");
            const tail = lines.slice(-50).join("\n");
            snippet = `${head}\n... [${lines.length - 150} lines omitted] ...\n${tail}`;
        }

        codeSnippets.push(`--- ${file.fileId} ---\n${snippet}`);
    }

    if (codeSnippets.length > 0) {
        parts.push(`\nRELEVANT SOURCE CODE:\n${codeSnippets.join("\n\n")}`);
    }

    return parts.join("\n");
}

// ── callGeminiForMapping ──────────────────────────────────────────────────────

/**
 * Calls Gemini 2.0 Flash to map an issue to repository files.
 *
 * - context: structured string from buildIssueContext()
 * - fileList: sorted list of files from the repository (used for validation)
 * - issueNumber / issueTitle: for the prompt
 * - comments: for the prompt discussion section
 *
 * Returns { affectedFiles, summary } or null if Gemini fails.
 * On any failure the caller must fall back to the deterministic result.
 */
export async function callGeminiForMapping(
    context: string,
    fileList: Array<{ id: string; architecturalImportance?: number }>,
    issueNumber: number,
    issueTitle: string,
    issue: IssueContextInput,
): Promise<GeminiMappingResult | null> {
    const client = getGeminiClient();
    if (!client) {
        console.log("[issueAnalyzer] Gemini key not configured, skipping AI step");
        return null;
    }

    const model = client.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction:
            "You are a senior software engineer analyzing a GitHub issue. " +
            "You will be given an issue description and a list of files from the repository. " +
            "Your job is to identify which files need to change to fix this issue. " +
            "Return ONLY valid JSON. No markdown. No explanation outside JSON.",
        generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1000,
        },
    });

    // Build the sorted file list string (by architectural importance)
    const fileListStr = [...fileList]
        .sort((a, b) => (b.architecturalImportance ?? 0) - (a.architecturalImportance ?? 0))
        .slice(0, 100)
        .map(f => `${f.id}`)
        .join("\n");

    // Discussion section
    const discussionSection = issue.comments.length > 0
        ? `DISCUSSION (${issue.comments.length} comments):\n${
            issue.comments.slice(0, 3).map(c => c.body.slice(0, 200)).join("\n---\n")
          }`
        : "";

    const prompt = [
        `ISSUE #${issueNumber}: ${issueTitle}`,
        ``,
        `DESCRIPTION:`,
        issue.body.slice(0, 800),
        discussionSection ? `\n${discussionSection}` : "",
        ``,
        `REPOSITORY FILES (sorted by architectural importance):`,
        fileListStr,
        context.includes("RELEVANT SOURCE CODE") ? `\n${context.split("RELEVANT SOURCE CODE")[1] ? "RELEVANT SOURCE CODE" + context.split("RELEVANT SOURCE CODE")[1] : ""}` : "",
        ``,
        `TASK: Which files need to change to fix this issue?`,
        ``,
        `Return JSON:`,
        `{`,
        `  "affectedFiles": [`,
        `    {`,
        `      "fileId": "exact/path/from/file/list/above.js",`,
        `      "confidence": 87,`,
        `      "reason": "This file contains the method that needs to change per the issue"`,
        `    }`,
        `  ],`,
        `  "summary": "One paragraph explaining what the issue is about and what changes are needed"`,
        `}`,
    ].filter(Boolean).join("\n");

    const fileIdSet = new Set(fileList.map(f => f.id));

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();

        // Strip markdown code fences if Gemini wraps the output
        const cleaned = text.replace(/```json\s*|```\s*/g, "").trim();
        const parsed = JSON.parse(cleaned);

        const affectedFiles: AffectedFile[] = (parsed.affectedFiles ?? [])
            .filter((f: AffectedFile) => fileIdSet.has(f.fileId))
            .map((f: AffectedFile) => ({
                fileId: f.fileId,
                confidence: Math.max(0, Math.min(100, Math.round(Number(f.confidence) || 0))),
                reason: String(f.reason ?? "").slice(0, 300),
            }));

        const summary = String(parsed.summary ?? "").slice(0, 1000);

        return { affectedFiles, summary };
    } catch (err) {
        console.error("[issueAnalyzer] Gemini mapping failed, falling back to deterministic:", err);
        return null;
    }
}

// ── callGeminiForFix ──────────────────────────────────────────────────────────

/**
 * Phase 2 — Suggest the actual code fix for a specific mapped file.
 *
 * Wire the function but don't call it yet from the routes.
 * Called only when user explicitly clicks "Suggest Fix" on a specific file.
 *
 * Context sent to Gemini:
 *   - Issue title + body (800 chars)
 *   - Primary file full content (if ≤ 300 lines, send all)
 *   - Connected files (directly import or imported by primary) — max 3, max 100 lines each
 *
 * Returns { explanation, replacementBlocks[] } | null
 */
export async function callGeminiForFix(
    issue: IssueContextInput,
    fileId: string,
    fileContent: string,
    connectedFilesContent: Map<string, string>,
): Promise<GeminiFixResult | null> {
    const client = getGeminiClient();
    if (!client) {
        console.log("[issueAnalyzer] Gemini key not configured, cannot suggest fix");
        return null;
    }

    const model = client.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction:
            "You are a senior software engineer. Given a GitHub issue and a file's source code, " +
            "identify the minimal change needed to fix the issue. " +
            "Return ONLY valid JSON. No markdown. No explanation outside JSON.",
        generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2000,
        },
    });

    // Primary file — send all if ≤ 300 lines, else truncate
    const primaryLines = fileContent.split("\n");
    const primarySnippet = primaryLines.length <= 300
        ? fileContent
        : [...primaryLines.slice(0, 200), "... [truncated] ...", ...primaryLines.slice(-100)].join("\n");

    // Connected files — max 3, max 100 lines each
    const connectedSnippets: string[] = [];
    let count = 0;
    for (const [connId, connContent] of connectedFilesContent) {
        if (count >= 3) break;
        const connLines = connContent.split("\n").slice(0, 100).join("\n");
        connectedSnippets.push(`--- ${connId} ---\n${connLines}`);
        count++;
    }

    const prompt = [
        `ISSUE: ${issue.title}`,
        issue.body.slice(0, 800),
        ``,
        `PRIMARY FILE TO FIX: ${fileId}`,
        primarySnippet,
        connectedSnippets.length > 0 ? `\nCONNECTED FILES:\n${connectedSnippets.join("\n\n")}` : "",
        ``,
        `TASK: What is the minimal change needed to fix this issue?`,
        `Return a replacement block showing the exact lines to change.`,
        ``,
        `Return JSON:`,
        `{`,
        `  "explanation": "what needs to change and why",`,
        `  "replacementBlocks": [`,
        `    {`,
        `      "original": "exact lines to replace",`,
        `      "replacement": "new lines"`,
        `    }`,
        `  ]`,
        `}`,
    ].filter(Boolean).join("\n");

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const cleaned = text.replace(/```json\s*|```\s*/g, "").trim();
        const parsed = JSON.parse(cleaned);

        return {
            explanation: String(parsed.explanation ?? "").slice(0, 1000),
            replacementBlocks: (parsed.replacementBlocks ?? []).map((b: { original: string; replacement: string }) => ({
                original: String(b.original ?? ""),
                replacement: String(b.replacement ?? ""),
            })),
        };
    } catch (err) {
        console.error("[issueAnalyzer] Gemini fix suggestion failed:", err);
        return null;
    }
}
