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
import { fetchIssue, fetchOpenIssues, fetchIssueComments } from "../github/issueClient";
import { mapIssueToCode, buildInlineSearchIndex } from "../parser/issueMapper";
import { buildIssueContext, callGeminiForMapping } from "../parser/issueAnalyzer";
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
            const issueContext = buildIssueContext(
                { title: issue.title, body: issue.body, comments },
                deterministicFiles,
                new Map(), // no file contents in Phase 1
            );

            const geminiResult = await callGeminiForMapping(
                issueContext,
                sortedFiles,
                issueNumber,
                issue.title,
                { title: issue.title, body: issue.body, comments },
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

export default router;
