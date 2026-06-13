// src/routes/issueMap.ts
// ─────────────────────────────────────────────────────────────────────────────
// Issue mapping routes — thin request/response wiring ONLY.
//
// WHAT THIS FILE DOES:
//   - Validate incoming requests (Zod schemas)
//   - Check and write the Redis result cache
//   - Fetch raw GitHub data (issue, comments, linked PRs)
//   - Delegate all business logic to issuePipeline.runIssueMappingPipeline()
//   - Build and return the response in the shape the frontend expects
//
// WHAT THIS FILE INTENTIONALLY DOES NOT DO:
//   - No deterministic keyword matching (lives in issueMapper.ts)
//   - No AI prompt building (lives in issueAnalyzer.ts)
//   - No graph traversal (lives in issueMapper.ts)
//   - No snippet fetching (lives in snippetFetcher.ts)
//   - No merging of results from different sources (lives in issuePipeline.ts)
//   - No inline search index building (lives in issueMapper.ts)
//
// GRACEFUL DEGRADATION (enforced at this layer):
//   - Redis down → skip cache, run pipeline, return result without caching
//   - GitHub issue 404 → return 404 to client (correct behavior, not degradation)
//   - GitHub comments/PRs fail → pass empty arrays to pipeline (pipeline handles)
//   - Pipeline throws → return empty result with source="deterministic", never 500
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { redisConnection } from "../queue/jobQueue";
import { getFileGraph } from "../storage/artifactStore";
import {
    fetchIssue,
    fetchOpenIssues,
    fetchIssueComments,
    fetchLinkedPRs,
    fetchRawFile,
} from "../github/issueClient";
import {
    runIssueMappingPipeline,
    type PipelineInput,
} from "../parser/issuePipeline";
import { smartTruncate, callGeminiForChatStream, type AffectedFile } from "../parser/issueAnalyzer";
import { buildChatContext } from "../parser/chatContextBuilder";
import { rateLimiter, getClientIdentifier, getDateString } from "../middleware/rateLimiter";

const router = Router();

// ── Zod schemas ───────────────────────────────────────────────────────────────
// These are kept exactly as-is — the frontend depends on these shapes.

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
            id:                      z.string(),
            label:                   z.string(),
            architecturalImportance: z.number().optional().default(0),
        })).max(3000),
        functions: z.array(z.object({
            id:       z.string(),
            name:     z.string(),
            filePath: z.string(),
        })).max(5000).optional().default([]),
    }).optional(),
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
// These shapes are consumed by the frontend — do not change field names or remove fields.

interface AffectedFunction {
    functionId: string;
    filePath:   string;
    confidence: number;
    reason:     string;
}

interface IssueMapResponse {
    issueNumber:       number;
    issueTitle:        string;
    issueBody:         string;
    issueUrl:          string;
    affectedFiles:     AffectedFile[];
    affectedFunctions: AffectedFunction[];
    source:            "cache" | "deterministic" | "ai";
    overallConfidence: number;
    summary?:          string;
}

// ── POST /issue-map/fetch-issues ──────────────────────────────────────────────
// Unchanged from Phase 1 — returns open issues list with 5-minute cache.

router.post("/fetch-issues", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { owner, repo } = FetchIssuesRequestSchema.parse(req.body);

        const cacheKey = `issues-list:${owner}:${repo}`;

        // Graceful Redis failure: if get() throws, treat as cache miss
        let cached: string | null = null;
        try {
            cached = await redisConnection.get(cacheKey);
        } catch {
            // Redis unavailable — skip cache, fetch fresh
        }

        if (cached) {
            return res.json({ source: "cache", issues: JSON.parse(cached) });
        }

        const issues = await fetchOpenIssues(owner, repo, 100);
        const summaries = issues.map(issue => ({
            number:  issue.number,
            title:   issue.title,
            htmlUrl: issue.htmlUrl,
            labels:  issue.labels,
            state:   issue.state,
        }));

        // Cache write failure is never fatal
        try {
            await redisConnection.set(cacheKey, JSON.stringify(summaries), "EX", 300);
        } catch {
            // Redis down — continue without caching
        }

        return res.json({ source: "fresh", issues: summaries });
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request", details: err.issues });
        }
        next(err);
    }
});

// ── POST /issue-map/map ────────────────────────────────────────────────────────
//
// Thin orchestration: validate → cache check → GitHub fetch → pipeline → cache write → respond.
//
// All business logic (deterministic matching, graph traversal, snippet fetching,
// AI reasoning, result merging) lives in runIssueMappingPipeline().
//
// FALLBACK CHAIN (documented for future maintainers):
//   1. Redis cache hit → return immediately, no pipeline run
//   2. Redis down → skip cache check, run pipeline anyway
//   3. RetrievalIndex in Redis → new pipeline (graph traversal + snippets + Gemini)
//   4. RetrievalIndex missing → legacy pipeline (inline index + Gemini with no snippets)
//   5. Gemini fails in pipeline → pipeline returns geminiResult=null
//   6. geminiResult=null → response has empty affectedFiles, source="deterministic"
//   7. Pipeline throws → same as step 6, log error, never 500

router.post("/map", async (req: Request, res: Response, next: NextFunction) => {
    try {
        // ── Step 1: Validate ──────────────────────────────────────────────────
        const { owner, repo, commitSha, issueNumber, graphData } = IssueMapRequestSchema.parse(req.body);

        // ── Step 2: Redis cache check ─────────────────────────────────────────
        // Cache key: (owner, repo, issueNumber, commitSha)
        // No TTL — same SHA means same code means same result, forever.
        // Degradation: Redis down → treat as cache miss, run pipeline.
        const cacheKey = `issue-map:${owner}:${repo}:${issueNumber}:${commitSha}`;
        try {
            const cached = await redisConnection.get(cacheKey);
            if (cached) {
                const result = JSON.parse(cached) as IssueMapResponse;
                return res.json({ ...result, source: "cache" });
            }
        } catch {
            console.warn("[issueMap] Redis unavailable for cache check — running pipeline");
        }

        // ── Step 3: Fetch issue from GitHub ───────────────────────────────────
        // Issue 404 → return 404 to client (correct behavior, not degradation).
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

        // Comments and linked PRs: failures are non-fatal — pass empty arrays.
        const comments  = await fetchIssueComments(owner, repo, issueNumber, 20).catch(() => []);
        const linkedPRs = await fetchLinkedPRs(owner, repo, issueNumber).catch(() => []);

        console.log(
            `[issueMap] fetched issue #${issueNumber}: "${issue.title}" ` +
            `(${comments.length} comments, ${linkedPRs.length} linked PRs)`
        );

        // ── Step 3.5: Resolve graph data ──────────────────────────────────────
        // graphData comes from the request body (frontend sends it inline),
        // OR from Redis (when the frontend doesn't include it).
        // Degradation: if neither available, return 400 — cannot map without file list.
        let resolvedGraphData = graphData;
        if (!resolvedGraphData) {
            try {
                // R2-first via artifact store (legacy Redis graph: key is the fallback).
                const parsed = await getFileGraph<{ files?: any[] }>(owner, repo);
                if (parsed) {
                    resolvedGraphData = {
                        files: (parsed.files ?? []).map((f: any) => ({
                            id:                      f.id as string,
                            label:                   f.label as string,
                            architecturalImportance: (f.architecturalImportance ?? 0) as number,
                        })),
                        functions: [],
                    };
                    console.log(
                        `[issueMap] graph data recovered from store (${resolvedGraphData.files.length} files)`
                    );
                }
            } catch {
                // Store unavailable — resolvedGraphData stays null
            }
        }

        if (!resolvedGraphData?.files.length) {
            return res.status(400).json({
                error: "Graph data missing and not found in cache. Please re-analyze the repo.",
            });
        }

        // ── Step 4: Run the pipeline ──────────────────────────────────────────
        // issuePipeline owns all business logic from here.
        // The route only provides: what files exist, what the issue is.
        const graphFileIds = new Set(resolvedGraphData.files.map(f => f.id));

        const pipelineInput: PipelineInput = {
            owner,
            repo,
            commitSha,
            issue: {
                title:      issue.title,
                body:       issue.body,
                comments,
                linkedPRs,
            },
            linkedPRs,
            graphFileIds,
            legacyFiles: resolvedGraphData.files,
        };

        let pipelineResult;
        try {
            pipelineResult = await runIssueMappingPipeline(pipelineInput);
        } catch (err) {
            // Pipeline threw unexpectedly — return graceful empty result, not 500.
            console.error("[issueMap] pipeline threw unexpectedly:", (err as Error).message);
            pipelineResult = {
                geminiResult:    null,
                usedNewPipeline: false,
                snippetCount:    0,
                isVague:         false,
                intent:          null,
                fallbackFiles:   [],
            };
        }

        // ── Step 5: Build response ────────────────────────────────────────────
        // Translate PipelineResult → IssueMapResponse (the frontend contract).
        const { geminiResult, usedNewPipeline, snippetCount, fallbackFiles } = pipelineResult;

        let affectedFiles: AffectedFile[]         = [];
        const affectedFunctions: AffectedFunction[] = []; // populated by future suggest-fix
        let source: IssueMapResponse["source"]    = "deterministic";
        let summary: string | undefined;

        if (geminiResult && geminiResult.affectedFiles.length > 0) {
            affectedFiles = geminiResult.affectedFiles;
            source        = "ai";
            summary       = geminiResult.summary;
            console.log(
                `[issueMap] mapping succeeded — ${affectedFiles.length} files, ` +
                `${snippetCount} snippets, new_pipeline=${usedNewPipeline}`
            );
        } else {
            affectedFiles = [];
            console.log(
                `\x1b[31m[issueMap] pipeline returned no AI result — 0 files found. ` +
                `new_pipeline=${usedNewPipeline}, snippets=${snippetCount}\x1b[0m`
            );
        }

        const overallConfidence = affectedFiles.length > 0
            ? Math.max(...affectedFiles.map(f => f.confidence))
            : 0;

        const response: IssueMapResponse = {
            issueNumber,
            issueTitle:        issue.title,
            issueBody:         issue.body,
            issueUrl:          issue.htmlUrl,
            affectedFiles,
            affectedFunctions,
            source,
            overallConfidence,
            summary,
        };

        // ── Step 6: Cache result ──────────────────────────────────────────────
        // Only cache when we have a useful result.
        // Cache failure is never fatal.
        if (affectedFiles.length > 0) {
            try {
                await redisConnection.set(cacheKey, JSON.stringify(response));
            } catch {
                console.warn("[issueMap] failed to write result to cache (Redis down)");
            }
        }

        return res.json(response);
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request", details: err.issues });
        }
        next(err);
    }
});

// ── POST /issue-map/suggest-fix (501 stub) ────────────────────────────────────
// Not implemented — stub kept so the frontend can show a "coming soon" state.

router.post("/suggest-fix", async (req: Request, res: Response) => {
    const result = SuggestFixRequestSchema.safeParse(req.body);
    if (!result.success) {
        return res.status(400).json({ error: "Invalid request", details: result.error.issues });
    }
    return res.status(501).json({ error: "Fix suggestions coming soon" });
});

// ── POST /issue-map/chat ──────────────────────────────────────────────────────
const MAX_CHAT_HISTORY_CHARS = 12000;

function filterMessagesByBudget(
  messages: Array<{ role: "user" | "model" | "assistant"; content: string }>
): Array<{ role: "user" | "model" | "assistant"; content: string }> {
  const result: Array<{ role: "user" | "model" | "assistant"; content: string }> = [];
  let accumulatedChars = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    // Always include the latest message so we don't end up with an empty history
    if (i === messages.length - 1) {
      result.unshift(msg);
      accumulatedChars += msg.content.length;
      continue;
    }
    if (accumulatedChars + msg.content.length > MAX_CHAT_HISTORY_CHARS) {
      break;
    }
    result.unshift(msg);
    accumulatedChars += msg.content.length;
  }

  return result;
}

const ChatRequestSchema = z.object({
    owner:         z.string().min(1).max(100),
    repo:          z.string().min(1).max(100),
    commitSha:     z.string().min(1).max(200),
    issueNumber:   z.number().int().positive().optional(),
    currentFileId: z.string().min(1).max(500),
    messages:      z.array(
        z.object({
            role: z.enum(["user", "model", "assistant"]),
            content: z.string().min(1)
        })
    ).min(1)
});

router.post("/chat", rateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = ChatRequestSchema.parse(req.body);
    const { owner, repo, commitSha, currentFileId, issueNumber, messages } = parsed;

    const lastMessage = messages[messages.length - 1];
    const lastMessageContent = lastMessage?.content || "";

    // Resolve graphFileIds — R2-first via artifact store (legacy Redis fallback inside).
    const graphFileIds = new Set<string>();
    try {
      const parsedGraph = await getFileGraph<{ files?: any[] }>(owner, repo, commitSha);
      if (parsedGraph && Array.isArray(parsedGraph.files)) {
        for (const file of parsedGraph.files) {
          if (file && typeof file.id === "string") {
            graphFileIds.add(file.id);
          }
        }
      }
    } catch (err) {
      console.warn("[chatRoute] Failed to fetch graph files from store:", err);
    }

    const retrievalStartTime = Date.now();
    const context = await buildChatContext({
      currentFileId,
      userMessage: lastMessageContent,
      owner,
      repo,
      commitSha,
      graphFileIds,
      issueNumber
    });
    const retrievalTimeMs = Date.now() - retrievalStartTime;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const budgetedMessages = filterMessagesByBudget(messages);

    const geminiStartTime = Date.now();
    const result = await callGeminiForChatStream(context.systemInstruction, budgetedMessages);

    let completionText = "";
    for await (const chunk of result.stream) {
      const text = chunk.text();
      completionText += text;
      res.write(`data: ${JSON.stringify(text)}\n\n`);
    }

    res.write("data: [DONE]\n\n");
    res.end();

    const geminiExecutionTimeMs = Date.now() - geminiStartTime;

    // Track tokens & telemetry asynchronously
    (async () => {
      let promptTokens = 0;
      let completionTokens = 0;
      try {
        const finalResponse = await result.response;
        const usage = finalResponse.usageMetadata;
        if (usage) {
          promptTokens = usage.promptTokenCount ?? 0;
          completionTokens = usage.candidatesTokenCount ?? 0;
        }
      } catch (err) {
        // Usage metadata not available yet
      }

      if (!promptTokens) {
        const totalPromptChars = context.systemInstruction.length + budgetedMessages.map(m => m.content).join(" ").length;
        promptTokens = Math.ceil(totalPromptChars / 4);
      }
      if (!completionTokens) {
        completionTokens = Math.ceil(completionText.length / 4);
      }

      const totalTokens = promptTokens + completionTokens;
      const clientIdentifier = (req as any).clientIdentifier || getClientIdentifier(req);
      const dateStr = getDateString();
      const tokKey = `rate-limit:tok:${clientIdentifier}:${dateStr}`;

      try {
        await redisConnection.incrby(tokKey, totalTokens);
        await redisConnection.expire(tokKey, 86400);
      } catch (err) {
        console.warn("[chatRoute] Failed to increment token usage in Redis:", err);
      }

      // Cost Telemetry
      const metrics = {
        timestamp: new Date().toISOString(),
        identifier: clientIdentifier,
        promptTokens,
        completionTokens,
        retrievalCandidates: context.candidateCount,
        snippetCount: context.snippets.length,
        retrievalTimeMs,
        geminiExecutionTimeMs,
      };

      try {
        await redisConnection.lpush("telemetry:chat", JSON.stringify(metrics));
        await redisConnection.ltrim("telemetry:chat", 0, 999);
      } catch (err) {
        console.warn("[chatRoute] Failed to write telemetry metrics to Redis:", err);
      }
    })().catch(err => console.error("[chatRoute] Error processing async telemetry:", err));

  } catch (err) {
    if (err instanceof z.ZodError) {
      res.write(`data: ${JSON.stringify("[Error] Invalid request: " + err.message)}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    console.error("[chatRoute] Error handling request:", err);
    res.write(`data: ${JSON.stringify("[Error] Internal server error.")}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

export default router;
