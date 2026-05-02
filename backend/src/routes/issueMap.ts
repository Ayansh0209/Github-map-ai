// src/routes/issueMap.ts
// ─────────────────────────────────────────────────────────────────────────────
// Issue mapping routes — thin request/response wiring only.
// No business logic. No AI calls. No prompt building.
//
// Routes:
//   POST /issue-map/fetch-issues  — get open issues list for a repo
//   POST /issue-map/map           — map a single issue to affected files
//   POST /issue-map/suggest-fix   — 501 stub (Phase 2)
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { redisConnection } from "../queue/jobQueue";
import { fetchIssue, fetchOpenIssues, fetchIssueComments, fetchLinkedPRs, fetchRawFile } from "../github/issueClient";
import { mapIssueToCode, buildInlineSearchIndex } from "../parser/issueMapper";
import { callGeminiForMapping, smartTruncate, callGeminiForChatStream } from "../parser/issueAnalyzer";
import type { AffectedFile } from "../parser/issueAnalyzer";
import { config } from "../config/config";

const router = Router();

// ── Zod schemas ───────────────────────────────────────────────────────────────

const FetchIssuesRequestSchema = z.object({
    owner: z.string().min(1).max(100),
    repo:  z.string().min(1).max(100),
});

const IssueMapRequestSchema = z.object({
    owner:       z.string().min(1).max(100),
    repo:        z.string().min(1).max(100),
    commitSha:   z.string().min(1).max(200),
    issueNumber: z.number().int().positive(),
    graphData: z.object({
        files: z.array(z.object({
            id:                     z.string(),
            label:                  z.string(),
            architecturalImportance: z.number().optional().default(0),
        })).max(200),
        functions: z.array(z.object({
            id:       z.string(),
            name:     z.string(),
            filePath: z.string(),
        })).max(500).optional().default([]),
    }),
});

const SuggestFixRequestSchema = z.object({
    owner:            z.string().min(1).max(100),
    repo:             z.string().min(1).max(100),
    commitSha:        z.string().min(1).max(200),
    issueNumber:      z.number().int().positive(),
    fileId:           z.string().min(1).max(500),
    connectedFileIds: z.array(z.string()).max(10).optional().default([]),
});

const ChatRequestSchema = z.object({
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    commitSha: z.string().min(1).max(200),
    issueNumber: z.number().int().positive(),
    fileId: z.string().min(1).max(500),
    connectedFileIds: z.array(z.string()).max(5).optional().default([]),
    messages: z.array(z.object({
        role: z.enum(["user", "model"]),
        content: z.string().max(2000),
    })).min(1).max(20),
});


// ── Response types ────────────────────────────────────────────────────────────

interface AffectedFunction {
    functionId: string;
    filePath:   string;
    confidence: number;
    reason:     string;
}

interface IssueMapResponse {
    issueNumber:      number;
    issueTitle:       string;
    issueBody:        string;
    issueUrl:         string;
    affectedFiles:    AffectedFile[];
    affectedFunctions: AffectedFunction[];
    source:           "cache" | "deterministic" | "ai";
    overallConfidence: number;
    summary?:         string;
}

// ── POST /issue-map/fetch-issues ──────────────────────────────────────────────

router.post("/fetch-issues", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { owner, repo } = FetchIssuesRequestSchema.parse(req.body);

        // Check Redis cache (5 min TTL — issues change)
        const cacheKey = `issues-list:${owner}:${repo}`;
        const cached = await redisConnection.get(cacheKey);
        if (cached) {
            return res.json({ source: "cache", issues: JSON.parse(cached) });
        }

        const issues = await fetchOpenIssues(owner, repo, 100);

        // Return issue summaries only (no body content in list view)
        const summaries = issues.map(issue => ({
            number:  issue.number,
            title:   issue.title,
            htmlUrl: issue.htmlUrl,
            labels:  issue.labels,
            state:   issue.state,
        }));

        await redisConnection.set(cacheKey, JSON.stringify(summaries), "EX", 300); // 5 min TTL

        return res.json({ source: "fresh", issues: summaries });
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request", details: err.issues });
        }
        next(err);
    }
});

// ── POST /issue-map/map ────────────────────────────────────────────────────────

router.post("/map", async (req: Request, res: Response, next: NextFunction) => {
    try {
        // Step 1 — Validate
        const { owner, repo, commitSha, issueNumber, graphData } = IssueMapRequestSchema.parse(req.body);

        // Step 2 — Redis cache check (no TTL — same issue + SHA = same result forever)
        const cacheKey = `issue-map:${owner}:${repo}:${issueNumber}:${commitSha}`;
        const cached = await redisConnection.get(cacheKey);
        if (cached) {
            const result = JSON.parse(cached) as IssueMapResponse;
            return res.json({ ...result, source: "cache" });
        }

        // Step 3 — Fetch issue + comments from GitHub
        let issue;
        try {
            issue = await fetchIssue(owner, repo, issueNumber);
        } catch (err: unknown) {
            const status = (err as { status?: number }).status;
            if (status === 404) {
                return res.status(404).json({
                    error: `Issue #${issueNumber} not found in ${owner}/${repo}`,
                });
            }
            throw err;
        }

        const comments = await fetchIssueComments(owner, repo, issueNumber, 20).catch(() => []);
        const linkedPRs = await fetchLinkedPRs(owner, repo, issueNumber);

        console.log(`[issueMap] Fetched issue #${issueNumber}: ${issue.title} (${comments.length} comments)`);

        // Step 4 — Deterministic matching via inline search index
        // Sort files by architectural importance (descending), cap at 200
        const sortedFiles = [...graphData.files]
            .sort((a, b) => (b.architecturalImportance ?? 0) - (a.architecturalImportance ?? 0))
            .slice(0, 200);

        const inlineIndex = buildInlineSearchIndex(sortedFiles);

        const query = `${issue.title} ${issue.body.slice(0, 500)}`;
        const deterministicResult = mapIssueToCode(query, inlineIndex, 10);

        const deterministicFiles: AffectedFile[] = deterministicResult.topFiles.map(f => ({
            fileId:     f.filePath,
            confidence: f.score,
            reason:     f.matchedReasons[0] ?? "Keyword match",
        }));

        const deterministicFunctions: AffectedFunction[] = deterministicResult.topFunctions.map(fn => ({
            functionId: fn.functionId,
            filePath:   fn.filePath,
            confidence: fn.score,
            reason:     fn.matchedReasons[0] ?? "Keyword match",
        }));

        const deterministicConfidence = deterministicResult.confidenceScore;

        console.log(`[issueMap] Deterministic matching finished. Found ${deterministicFiles.length} files. Max confidence: ${deterministicConfidence}`);
        if (deterministicFiles.length > 0) {
            console.log(`[issueMap] Top deterministic file: ${deterministicFiles[0].fileId} (${deterministicFiles[0].confidence}%)`);
        }

        // Step 5 — AI fallback if confidence < 70 and Gemini key is configured
        let affectedFiles   = deterministicFiles;
        let affectedFunctions = deterministicFunctions;
        let source: IssueMapResponse["source"] = "deterministic";
        let summary: string | undefined;

        console.log(`[issueMap] Evaluating AI fallback. Deterministic confidence: ${deterministicConfidence}. API Key present: ${!!config.gemini.apiKey}`);

        if (deterministicConfidence < 70 && config.gemini.apiKey) {
            // Build context (no file contents available at this layer — that's Phase 2)
            const issueContextInput = { title: issue.title, body: issue.body, comments, linkedPRs };
            const keywordHints = deterministicFiles.map(f => f.fileId);

            const geminiResult = await callGeminiForMapping(
                issueContextInput,
                sortedFiles,
                keywordHints
            );

            if (geminiResult) {
                // Merge: AI results take priority, keep deterministic hits AI missed
                const aiFileIds = new Set(geminiResult.affectedFiles.map(f => f.fileId));
                const merged = [...geminiResult.affectedFiles];
                for (const df of deterministicFiles) {
                    if (!aiFileIds.has(df.fileId)) merged.push(df);
                }
                affectedFiles = merged;
                source = "ai";
                summary = geminiResult.summary;
                console.log(`[issueMap] Gemini mapping succeeded. Found ${geminiResult.affectedFiles.length} files. Summary: ${summary.slice(0, 100)}...`);
            } else {
                console.log(`[issueMap] Gemini mapping failed. Falling back to deterministic results.`);
            }
        } else if (deterministicConfidence < 70) {
            console.log(`[issueMap] Gemini key not configured, using deterministic only`);
        } else {
            console.log(`[issueMap] Deterministic confidence (${deterministicConfidence}) >= 70. Skipping AI step.`);
        }

        // Overall confidence — max of all affected files
        const overallConfidence = affectedFiles.length > 0
            ? Math.max(...affectedFiles.map(f => f.confidence))
            : deterministicConfidence;

        // Step 6 — Cache forever (no TTL)
        const response: IssueMapResponse = {
            issueNumber,
            issueTitle:   issue.title,
            issueBody:    issue.body,
            issueUrl:     issue.htmlUrl,
            affectedFiles,
            affectedFunctions,
            source,
            overallConfidence,
            summary,
        };

        await redisConnection.set(cacheKey, JSON.stringify(response));

        return res.json(response);
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request", details: err.issues });
        }
        next(err);
    }
});

// Phase 2 implementation will:
// 1. Fetch primary fileId content from GitHub raw API
// 2. Fetch connectedFileIds content from GitHub raw API (max 10 files)
// 3. Truncate each file: first 150 lines + last 30 lines if > 200 lines
// 4. Call callGeminiForFix() from issueAnalyzer.ts with:
//    { issue, primaryFile: {id, content}, connectedFiles: [{id, content}] }
// 5. Return replacement blocks
// Cost estimate: ~$0.01-0.05 per fix depending on file sizes
// Cache key: fix:{owner}:{repo}:{issueNumber}:{fileId}:{commitSha}

// ── POST /issue-map/suggest-fix (501 stub — Phase 2) ─────────────────────────

router.post("/suggest-fix", async (req: Request, res: Response) => {
    // Validate the body so the client knows the schema is correct
    const result = SuggestFixRequestSchema.safeParse(req.body);
    if (!result.success) {
        return res.status(400).json({ error: "Invalid request", details: result.error.issues });
    }
    return res.status(501).json({ error: "Fix suggestions coming soon" });
});


// ── POST /issue-map/chat ──────────────────────────────────────────────────────

router.post("/chat", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { owner, repo, commitSha, issueNumber, fileId, connectedFileIds, messages } = ChatRequestSchema.parse(req.body);

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        const cacheKey = `issue-chat-ctx:${owner}:${repo}:${issueNumber}:${fileId}:${commitSha}`;
        let systemContext = await redisConnection.get(cacheKey);

        if (!systemContext) {
            const [issue, comments, linkedPRs, primaryFileContent] = await Promise.all([
                fetchIssue(owner, repo, issueNumber),
                fetchIssueComments(owner, repo, issueNumber, 5),
                fetchLinkedPRs(owner, repo, issueNumber),
                fetchRawFile(owner, repo, commitSha, fileId)
            ]);

            const connectedContents = await Promise.all(
                connectedFileIds.map((id: string) => fetchRawFile(owner, repo, commitSha, id).then((content: string) => ({ id, content })))
            );

            const issueTerms = [...new Set((issue.title + " " + issue.body).match(/\b([a-z][a-zA-Z0-9_]{2,}|[A-Z][a-zA-Z0-9_]{2,})\b/g) || [])];
            const primaryTruncated = smartTruncate(primaryFileContent, issueTerms, 300);
            
            const connectedParts = connectedContents
                .filter((c: any) => c.content)
                .map((c: any) => `-- ${c.id} --\n${smartTruncate(c.content, issueTerms, 80)}`)
                .join("\n\n");

            const prLines = linkedPRs.map((pr: any) => 
                `  PR #${pr.number} [${pr.merged ? 'MERGED' : pr.state.toUpperCase()}]: ${pr.title}\n  Changed files: ${pr.changedFiles.slice(0, 10).join(', ')}`
            ).join("\n");

            systemContext = [
                `REPOSITORY: ${owner}/${repo}`,
                `ISSUE #${issueNumber}: ${issue.title}`,
                "",
                "ISSUE DESCRIPTION:",
                issue.body.slice(0, 600),
                "",
                "LINKED PULL REQUESTS:",
                prLines || "None",
                "",
                `PRIMARY FILE: ${fileId}`,
                primaryTruncated,
                "",
                connectedParts ? `CONNECTED FILES:\n${connectedParts}` : ""
            ].join("\n");

            await redisConnection.set(cacheKey, systemContext);
        }

        const result = await callGeminiForChatStream(systemContext, messages);
        
        for await (const chunk of result.stream) {
            const text = chunk.text();
            res.write(`data: ${JSON.stringify(text)}\n\n`);
        }
        
        res.write("data: [DONE]\n\n");
        res.end();
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.write(`data: ${JSON.stringify("[Error] Invalid request: " + err.message)}\n\n`);
            res.write("data: [DONE]\n\n");
            return res.end();
        }
        console.error("[issueMap chat] Error:", err);
        res.write(`data: ${JSON.stringify("[Error] Failed to process chat request.")}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
    }
});

export default router;
