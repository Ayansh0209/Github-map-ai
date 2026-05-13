import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config/config";
import type { IssueComment, LinkedPR } from "../github/issueClient";
import type { CodeSnippet } from "./snippetFetcher";

export interface AffectedFile {
    fileId: string;
    confidence: number;   // 0-100
    reason: string;
}

export interface GeminiMappingResult {
    affectedFiles: AffectedFile[];
    summary: string;
    fixApproach: string;
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



// Smart truncation
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
        return `... [Showing relevant sections] ...\n\n${relevantLines.join("\n")}`;
    }
    return [...lines.slice(0, 150), "\n... omitted ...\n", ...lines.slice(-50)].join("\n");
}

function extractTechnicalTerms(text: string): string[] {
    const matches = text.match(/\b([a-z][a-zA-Z0-9_]{2,}|[A-Z][a-zA-Z0-9_]{2,})\b/g) ?? [];
    return [...new Set(matches.slice(0, 20))];
}

// ── Snippet formatter ─────────────────────────────────────────────────────────

/**
 * Format code snippets into a structured prompt section.
 *
 * Each snippet is presented with:
 *   - File path and function name as a header
 *   - Source signals that explain WHY this snippet was selected
 *   - The actual code body in a fenced block
 *
 * This format helps Gemini understand the retrieval reasoning and evaluate
 * each snippet independently.
 */
function formatSnippetsForPrompt(snippets: CodeSnippet[]): string {
    if (snippets.length === 0) {
        return "(No code snippets available — analyze based on issue text only)";
    }

    return snippets.map((s, i) => {
        const signals: string[] = [];
        if (s.hasAuthCheck)    signals.push("contains auth/permission check");
        if (s.hasDatabaseCall) signals.push("contains database operations");
        signals.push(...s.selectionReasons.slice(0, 2));

        const header = [
            `--- Snippet ${i + 1} ---`,
            `File: ${s.fileId}`,
            `Function: ${s.functionName} (lines ${s.startLine}-${s.endLine})`,
            signals.length > 0 ? `Signals: ${signals.join("; ")}` : "",
        ].filter(Boolean).join("\n");

        return `${header}\n\`\`\`\n${s.body}\n\`\`\``;
    }).join("\n\n");
}

// Logging
function logUsage(operation: string, usage: any, prompt: string, response: string) {
    if (!usage) return;
    const { promptTokenCount, candidatesTokenCount } = usage;
    const cost = (promptTokenCount * 0.000000075) + (candidatesTokenCount * 0.0000003);
    console.log(`\n\x1b[1;31m[AI FULL LOG - ${operation.toUpperCase()}]\x1b[0m`);
    console.log(`\x1b[31m--- PROMPT ---\x1b[0m\n\x1b[33m${prompt}\x1b[0m`);
    console.log(`\x1b[31m--- RESPONSE ---\x1b[0m\n\x1b[32m${response}\x1b[0m`);
    console.log(`\x1b[1;31m[COST] $${cost.toFixed(6)}\x1b[0m\n`);
}

/**
 * Call Gemini to map an issue to affected files by reasoning over actual code.
 *
 * WHAT CHANGED (Phase 2):
 *   Old: received 100 filenames + keyword hints → asked Gemini to guess
 *   New: receives actual code snippets → asks Gemini to reason like a senior engineer
 *
 * The prompt deliberately:
 *   - Gives Gemini the ACTUAL function bodies, not just filenames
 *   - Does NOT include deterministic keyword hints (they biased the AI)
 *   - Asks Gemini to explain its reasoning in terms of the code it read
 *   - Makes Gemini the only ranking authority — not the keyword matcher
 *
 * BACKWARD COMPATIBILITY:
 *   The old route still calls this with (issue, files[], keywordHints[]).
 *   When the second argument is a file-shape array (has `id` field, not `fileId`),
 *   we pass an empty snippets array — Gemini reasons from issue text alone.
 *   This is still better than the old prompt which listed 100 filenames.
 *
 * @param issue     Issue context (title, body, comments, linked PRs)
 * @param snippets  Code snippets from snippetFetcher (actual function bodies)
 * @param linkedPRs Linked PRs for additional context (not for ranking)
 */
// Overload 1: new signature (Phase 2 pipeline)
export async function callGeminiForMapping(
    issue: IssueContextInput,
    snippets: CodeSnippet[],
    linkedPRs: LinkedPR[],
): Promise<GeminiMappingResult | null>;
// Overload 2: legacy signature (existing route, backward compat)
export async function callGeminiForMapping(
    issue: IssueContextInput,
    files: Array<{ id: string; architecturalImportance?: number }>,
    keywordHints: string[],
): Promise<GeminiMappingResult | null>;
// Implementation
export async function callGeminiForMapping(
    issue: IssueContextInput,
    snippetsOrFiles: CodeSnippet[] | Array<{ id: string; architecturalImportance?: number }>,
    linkedPRsOrHints: LinkedPR[] | string[],
): Promise<GeminiMappingResult | null> {
    const client = getClient();
    if (!client) return null;

    // Normalize overload arguments:
    // Old route calls: (issue, files[], keywordHints[]) — files have `id` not `fileId`
    // New pipeline calls: (issue, snippets[], linkedPRs[]) — snippets have `fileId`
    const isLegacyCall =
        snippetsOrFiles.length === 0 ||
        (snippetsOrFiles[0] && "id" in snippetsOrFiles[0] && !("fileId" in snippetsOrFiles[0]));

    const snippets: CodeSnippet[] = isLegacyCall
        ? [] // Legacy call: no snippets — Gemini reasons from issue text alone
        : (snippetsOrFiles as CodeSnippet[]);

    const linkedPRs: LinkedPR[] = (
        typeof linkedPRsOrHints[0] === "string" || linkedPRsOrHints.length === 0
    ) ? [] : (linkedPRsOrHints as LinkedPR[]);

    const model = client.getGenerativeModel({
        model: "gemini-2.5-pro",
        generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
        },
    });

    // Format the issue context
    const commentText = issue.comments.slice(0, 5)
        .map(c => `${c.author}: ${c.body.slice(0, 300)}`)
        .join("\n");

    const prContext = linkedPRs.length > 0
        ? linkedPRs.map(pr =>
            `PR #${pr.number} (${pr.state}${pr.merged ? ", merged" : ""}): ${pr.title}\n` +
            `Changed files: ${pr.changedFiles.slice(0, 10).join(", ")}`
          ).join("\n")
        : "No linked pull requests.";

    const snippetSection = formatSnippetsForPrompt(snippets);


    const legacyFiles = isLegacyCall ? (snippetsOrFiles as Array<{ id: string }>) : [];
    
    let prompt = "";
    if (isLegacyCall) {
        prompt = `You are a senior software engineer performing a code review to identify which files are involved in a bug or feature request.

You do not have the actual source code, only the file paths. Reason about which files are most likely affected based on their names and the issue context.

═══════════════════════════════════════════════
ISSUE
═══════════════════════════════════════════════
Title: ${issue.title}

Body:
${issue.body.slice(0, 2000)}

${commentText ? `Discussion:\n${commentText}\n` : ""}
${prContext !== "No linked pull requests." ? `\nLinked PRs:\n${prContext}\n` : ""}
═══════════════════════════════════════════════
CANDIDATE FILES
═══════════════════════════════════════════════
${legacyFiles.map(f => f.id).join("\n")}

═══════════════════════════════════════════════
INSTRUCTIONS
═══════════════════════════════════════════════
Analyze the issue and the candidate files above. Identify which files are likely involved.

Return JSON with this exact schema:
{
  "affectedFiles": [
    {
      "fileId": "<exact file path from the list above>",
      "confidence": <0-100>,
      "reason": "<1 sentence explaining why this file is relevant>"
    }
  ],
  "summary": "<1-2 sentences summarizing the issue>",
  "fixApproach": "<1-2 sentences on how to fix it>"
}

IMPORTANT:
- Only include files from the CANDIDATE FILES list
- Be highly selective. If you are not sure, do not include the file.
`;
    } else {
        prompt = `You are a senior software engineer performing a code review to identify which files and functions are involved in a bug or feature request.

You have been given the actual source code of the most relevant functions from this repository. Read the code carefully and reason like an engineer — not like a keyword matcher.

═══════════════════════════════════════════════
ISSUE
═══════════════════════════════════════════════
Title: ${issue.title}

Body:
${issue.body.slice(0, 2000)}

${commentText ? `Discussion:\n${commentText}\n` : ""}
${prContext !== "No linked pull requests." ? `\nLinked PRs:\n${prContext}\n` : ""}
═══════════════════════════════════════════════
CODE SNIPPETS
═══════════════════════════════════════════════
${snippetSection}

═══════════════════════════════════════════════
INSTRUCTIONS
═══════════════════════════════════════════════
Analyze the issue and the code snippets above. Identify which files and functions are involved.

For each affected file, explain:
1. What this code does (based on what you read, not just the filename)
2. Why it is relevant to this specific issue
3. What would need to change to fix this issue

Return JSON with this exact schema:
{
  "affectedFiles": [
    {
      "fileId": "<exact file path from the snippets above>",
      "confidence": <0-100>,
      "reason": "<1-2 sentences: what you read in the code and why it matters for this issue>"
    }
  ],
  "summary": "<2-3 sentences: what this issue is about based on the code>",
  "fixApproach": "<2-3 sentences: what would need to change at the code level to fix this>"
}

IMPORTANT:
- Only include files from the snippets above
- Confidence should reflect how certain you are based on the CODE you read, not the filename
- A confidence of 90+ means you can point to specific lines in the code that are the problem
- A confidence of 50-70 means the code is in the right area but you need more context
- Do not include files just because they have a related name — only include them if you read code that is actually involved
`;
    }

    try {
        const result = await model.generateContent(prompt);
        const res = await result.response;
        const text = res.text();
        logUsage("mapping", res.usageMetadata, prompt, text);

        const parsed = JSON.parse(text);
        return {
            affectedFiles: (parsed.affectedFiles ?? []).map((f: any) => ({
                fileId: String(f.fileId),
                confidence: Number(f.confidence) || 50,
                reason: String(f.reason || ""),
            })),
            summary: String(parsed.summary || ""),
            fixApproach: String(parsed.fixApproach || ""),
        };
    } catch (err) {
        console.error("[issueAnalyzer] Mapping failed:", err);
        return null;
    }
}

// Chat
export async function callGeminiForChatStream(
    systemInstruction: string,
    messages: Array<{ role: string; content: string }>
) {
    const client = getClient();
    if (!client) throw new Error("Gemini key missing");

    const model = client.getGenerativeModel({
        model: "gemini-2.5-pro",
        systemInstruction,
        generationConfig: { temperature: 0.2 },
    });

    // MAP ROLES: Gemini only accepts "user" and "model"
    const history = messages.slice(0, -1).map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
    }));
    
    const lastMessage = messages[messages.length - 1].content;
    const chat = model.startChat({ history });
    return chat.sendMessageStream(lastMessage);
}
