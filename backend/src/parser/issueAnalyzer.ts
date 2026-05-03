// backend/src/parser/issueAnalyzer.ts

import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config/config";
import type { IssueComment, LinkedPR } from "../github/issueClient";

export interface AffectedFile {
    fileId: string;
    confidence: number;   // 0-100
    reason: string;
}

export interface GeminiMappingResult {
    affectedFiles: AffectedFile[];
    summary: string;       // what the issue is about
    fixApproach: string;   // what kind of change is needed
}

export interface GeminiFixResult {
    explanation: string;
    replacementBlocks: Array<{
        fileId: string;
        original: string;
        replacement: string;
        lineHint?: number;
    }>;
}

export interface IssueContextInput {
    title: string;
    body: string;
    comments: IssueComment[];
    linkedPRs: LinkedPR[];
}

// Lazy singleton
let geminiClient: GoogleGenerativeAI | null = null;
function getClient(): GoogleGenerativeAI | null {
    if (!config.gemini.apiKey) return null;
    if (!geminiClient) geminiClient = new GoogleGenerativeAI(config.gemini.apiKey);
    return geminiClient;
}

// Build the file list string sent to Gemini
// Sorted by architectural importance, max 100 entries
function buildFileListString(
    files: Array<{ id: string; architecturalImportance?: number }>
): string {
    return [...files]
        .sort((a, b) => (b.architecturalImportance ?? 0) - (a.architecturalImportance ?? 0))
        .slice(0, 100)
        .map((f) => f.id)
        .join("\n");
}

// Smart truncation for large files
export function smartTruncate(content: string, issueTerms: string[], maxLines = 300): string {
    const lines = content.split("\n");
    if (lines.length <= maxLines) return content;

    const relevantLineIndices: number[] = [];

    lines.forEach((line, i) => {
        if (issueTerms.some((term) => line.toLowerCase().includes(term.toLowerCase()))) {
            for (let j = Math.max(0, i - 10); j <= Math.min(lines.length - 1, i + 10); j++) {
                relevantLineIndices.push(j);
            }
        }
    });

    if (relevantLineIndices.length > 0) {
        const uniqueIndices = [...new Set(relevantLineIndices)].sort((a, b) => a - b);
        const relevantLines = uniqueIndices.map((i) => `L${i + 1}: ${lines[i]}`);
        const head = lines.slice(0, 50).join("\n");
        return `${head}\n\n... [${lines.length} total lines, showing relevant sections] ...\n\n${relevantLines.join("\n")}`;
    }

    return [
        ...lines.slice(0, 150),
        `\n... [${lines.length - 200} lines omitted] ...\n`,
        ...lines.slice(-50),
    ].join("\n");
}

// Extract key technical terms from issue for context
function extractTechnicalTerms(text: string): string[] {
    // Match: camelCase, snake_case, function names, config keys, method names
    const matches = text.match(
        /\b([a-z][a-zA-Z0-9_]{2,}|[A-Z][a-zA-Z0-9_]{2,})\b/g
    ) ?? [];

    const SKIP = new Set([
        "the", "this", "that", "with", "from", "have", "will",
        "should", "would", "could", "does", "when", "what",
        "issue", "error", "problem", "user", "value", "option",
        "param", "query", "request", "response",
    ]);

    return [...new Set(
        matches
            .filter((t) => !SKIP.has(t.toLowerCase()) && t.length > 3)
            .slice(0, 20)
    )];
}

// Main mapping function â€” calls Gemini with full context
export async function callGeminiForMapping(
    issue: IssueContextInput,
    files: Array<{ id: string; architecturalImportance?: number }>,
    keywordHints: string[], // from deterministic matcher
): Promise<GeminiMappingResult | null> {
    const client = getClient();
    if (!client) {
        console.log("[issueAnalyzer] No Gemini key â€” skipping AI");
        return null;
    }

    const model = client.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction:
            "You are a senior software engineer helping contributors " +
            "navigate a codebase to fix a GitHub issue. " +
            "You understand code architecture, follow import chains, " +
            "and identify which files need to change. " +
            "Return ONLY valid JSON. No markdown. No explanation outside JSON.",
        generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1200,
        },
    });

    const fileListStr = buildFileListString(files);
    const technicalTerms = extractTechnicalTerms(issue.title + " " + issue.body);

    // PR section â€” most valuable signal
    let prSection = "";
    if (issue.linkedPRs.length > 0) {
        const prLines = issue.linkedPRs.map((pr) => {
            const status = pr.merged
                ? "MERGED"
                : pr.state === "closed"
                    ? "CLOSED"
                    : "OPEN";
            const files = pr.changedFiles.slice(0, 15).join(", ");
            return `  PR #${pr.number} [${status}]: ${pr.title}\n  Changed files: ${files}`;
        });
        prSection = `\nLINKED PULL REQUESTS (these show which files were changed):\n${prLines.join("\n")}`;
    }

    // Comments section â€” discussion context
    let commentSection = "";
    if (issue.comments.length > 0) {
        const commentLines = issue.comments
            .slice(0, 5)
            .map((c) => `[${c.author}]: ${c.body.slice(0, 300)}`);
        commentSection = `\nDISCUSSION:\n${commentLines.join("\n---\n")}`;
    }

    // Keyword hints from deterministic engine
    let hintsSection = "";
    if (keywordHints.length > 0) {
        hintsSection = `\nDETERMINISTIC HINTS (files matching keywords):\n${keywordHints.join("\n")}`;
    }

    const prompt = `ISSUE #${issue.title}

DESCRIPTION:
${issue.body.slice(0, 1000)}
${prSection}
${commentSection}
${hintsSection}

TECHNICAL TERMS DETECTED: ${technicalTerms.join(", ")}

REPOSITORY FILES (sorted by architectural importance):
${fileListStr}

TASK:
1. Understand what this issue is about technically
2. Identify which files need to change to fix it
3. Consider the linked PRs â€” if files were changed in a PR for this issue, they are almost certainly affected
4. Consider file names, paths, and architectural importance

Return JSON:
{
  "affectedFiles": [
    {
      "fileId": "exact/file/path.js",
      "confidence": 90,
      "reason": "This file contains the X function that handles Y"
    }
  ],
  "summary": "What this issue is about in 2 sentences",
  "fixApproach": "What kind of code change is needed"
}`;

    const fileIdSet = new Set(files.map((f) => f.id));

    console.log(`\n[issueAnalyzer] ----------------------------------------------------`);
    console.log(`[issueAnalyzer] Sending request to Gemini for issue: "${issue.title}"`);
    console.log(`[issueAnalyzer] Technical terms detected: ${technicalTerms.length}`);
    console.log(`[issueAnalyzer] Files provided in context: ${files.length}`);
    console.log(`[issueAnalyzer] Linked PRs: ${issue.linkedPRs.length}, Comments: ${issue.comments.length}`);
    console.log(`[issueAnalyzer] ----------------------------------------------------\n`);

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        
        console.log(`[issueAnalyzer] Gemini response received. Length: ${text.length} chars.`);
        console.log(`[issueAnalyzer] Raw response:\n${text}\n`);

        const cleaned = text.replace(/```json\s*|```\s*/g, "").trim();
        const parsed = JSON.parse(cleaned);

        console.log(`[issueAnalyzer] Parsed JSON successfully. Found ${parsed.affectedFiles?.length || 0} candidate files.`);

        const affectedFiles: AffectedFile[] = [];
        const fileIdArray = Array.from(fileIdSet);
        
        for (const f of parsed.affectedFiles ?? []) {
            let targetId = String(f.fileId).replace(/^\/+/, ''); // strip leading slash
            
            // Try exact match first
            let matchedId = fileIdSet.has(targetId) ? targetId : null;
            
            // Try case-insensitive or ending match
            if (!matchedId) {
                const lowerTarget = targetId.toLowerCase();
                matchedId = fileIdArray.find(id => id.toLowerCase() === lowerTarget || id.toLowerCase().endsWith('/' + lowerTarget)) || null;
            }

            if (matchedId) {
                affectedFiles.push({
                    fileId: matchedId,
                    confidence: Math.max(0, Math.min(100, Math.round(Number(f.confidence) || 0))),
                    reason: String(f.reason ?? "").slice(0, 300),
                });
            }
        }

        console.log(`[issueAnalyzer] After filtering by valid file IDs, ${affectedFiles.length} files remain.`);
        if (affectedFiles.length === 0) {
            console.log(`[issueAnalyzer] WARNING: Gemini returned files that don't match the repository file tree!`);
            console.log(`[issueAnalyzer] Gemini returned:`, parsed.affectedFiles);
        }

        return {
            affectedFiles,
            summary: String(parsed.summary ?? "").slice(0, 500),
            fixApproach: String(parsed.fixApproach ?? "").slice(0, 300),
        };
    } catch (err) {
        console.error("[issueAnalyzer] Gemini mapping failed with error:", err);
        return null;
    }
}

// Phase 2: suggest actual code fix
// Called only when user explicitly clicks "Suggest Fix"
// Handles large files by smart truncation
export async function callGeminiForFix(
    issue: IssueContextInput,
    primaryFile: { id: string; content: string },
    connectedFiles: Array<{ id: string; content: string }>,
): Promise<GeminiFixResult | null> {
    const client = getClient();
    if (!client) return null;

    const model = client.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction:
            "You are a senior software engineer. Given a GitHub issue and source code, " +
            "provide the minimal precise code change to fix the issue. " +
            "When suggesting fixes, always mention ALL files that need to change. " +
            "If test files need updating, include them explicitly. " +
            "Show the complete fix across all affected files, not just the primary file. " +
            "Return ONLY valid JSON. No markdown outside JSON.",
        generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2000,
        },
    });



    const primaryContent = smartTruncate(primaryFile.content, extractTechnicalTerms(issue.title + " " + issue.body), 300);

    const connectedContent = connectedFiles
        .slice(0, 3)
        .map((f) => `--- ${f.id} ---\n${smartTruncate(f.content, extractTechnicalTerms(issue.title + " " + issue.body), 100)}`)
        .join("\n\n");

    const prompt = `ISSUE: ${issue.title}
${issue.body.slice(0, 600)}

PRIMARY FILE TO FIX: ${primaryFile.id}
\`\`\`
${primaryContent}
\`\`\`
${connectedContent ? `\nCONNECTED FILES (imports/imported-by):\n${connectedContent}` : ""}

OTHER AFFECTED FILES (may also need changes):
${connectedFiles.map((f) => "--- " + f.id + " ---\n" + smartTruncate(f.content, extractTechnicalTerms(issue.title + " " + issue.body), 100)).join("\n\n")}

TASK: Provide the minimal code change to fix this issue.
Show exact lines to replace.

Return JSON:
{
  "explanation": "what needs to change and why",
  "replacementBlocks": [
    {
      "fileId": "${primaryFile.id}",
      "original": "exact original lines",
      "replacement": "new lines",
      "lineHint": 42
    }
  ]
}`;

    try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const cleaned = text.replace(/```json\s*|```\s*/g, "").trim();
        const parsed = JSON.parse(cleaned);

        return {
            explanation: String(parsed.explanation ?? "").slice(0, 1000),
            replacementBlocks: (parsed.replacementBlocks ?? []).map(
                (b: { fileId: string; original: string; replacement: string; lineHint?: number }) => ({
                    fileId: String(b.fileId ?? primaryFile.id),
                    original: String(b.original ?? ""),
                    replacement: String(b.replacement ?? ""),
                    lineHint: typeof b.lineHint === "number" ? b.lineHint : undefined,
                })
            ),
        };
    } catch (err) {
        console.error("[issueAnalyzer] Gemini fix failed:", err);
        return null;
    }
}

// Phase 2: Chat Stream
export async function callGeminiForChatStream(
    systemInstruction: string,
    messages: Array<{ role: "user" | "model"; content: string }>
) {
    const client = getClient();
    if (!client) throw new Error("Gemini API key not configured");

    const model = client.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction,
        generationConfig: { temperature: 0.2 },
    });

    // Truncate messages if > 12
    let truncatedMessages = messages;
    if (messages.length > 12) {
        const first3 = messages.slice(0, 3);
        const middle = messages.slice(3, -4);
        const last4 = messages.slice(-4);
        
        const summaryContent = middle.map(m => m.content.slice(0, 50)).join(" | ");
        
        truncatedMessages = [
            ...first3,
            { role: "user", content: `[System] Previous conversation summary: ${summaryContent}...` },
            ...last4
        ];
    }

    const history = truncatedMessages.slice(0, -1).map(m => ({
        role: m.role,
        parts: [{ text: m.content }]
    }));
    
    const lastMessage = truncatedMessages[truncatedMessages.length - 1].content;
    
    const chat = model.startChat({ history });
    return chat.sendMessageStream(lastMessage);
}
