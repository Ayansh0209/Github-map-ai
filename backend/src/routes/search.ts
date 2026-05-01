// src/routes/search.ts
// ─────────────────────────────────────────────────────────────────────────────
// Search API endpoints for the code intelligence platform.
//
// Reads the search index from Redis (persisted alongside graph cache)
// and runs deterministic queries against it.
//
// Endpoints:
//   GET /search?q=<query>&type=<file|function|export|test>&kind=<kind>&package=<pkg>&limit=<n>
//   GET /search/symbols?q=<query>&kind=<kind>&limit=<n>
//   GET /search/files?q=<query>&kind=<kind>&package=<pkg>&limit=<n>
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { redisConnection } from "../queue/jobQueue";
import { searchIndex } from "../search/queryEngine";
import { mapIssueToCode } from "../parser/issueMapper";
import type { SearchIndex, FileNode } from "../models/schema";

const router = Router();

// ── Validation ────────────────────────────────────────────────────────────────

const searchQuerySchema = z.object({
    q:       z.string().min(1).max(200),
    type:    z.enum(["file", "function", "export", "test"]).optional(),
    kind:    z.string().max(50).optional(),
    package: z.string().max(100).optional(),
    limit:   z.coerce.number().int().min(1).max(200).default(50),
    owner:   z.string().min(1).max(100),
    repo:    z.string().min(1).max(100),
});

// ── Index retrieval from Redis ────────────────────────────────────────────────

async function getSearchIndex(owner: string, repo: string): Promise<SearchIndex | null> {
    try {
        const key = `search:${owner}:${repo}`;
        const cached = await redisConnection.get(key);
        if (cached) return JSON.parse(cached) as SearchIndex;
        return null;
    } catch {
        return null;
    }
}

/**
 * Retrieve file nodes from the cached file graph.
 * Needed by the issue mapper for architectural scoring context.
 */
async function getFileNodes(owner: string, repo: string): Promise<FileNode[]> {
    try {
        const key = `graph:${owner}:${repo}`;
        const cached = await redisConnection.get(key);
        if (cached) {
            const parsed = JSON.parse(cached);
            return (parsed.files ?? []) as FileNode[];
        }
        return [];
    } catch {
        return [];
    }
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /search — universal search across all entry types
 */
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const params = searchQuerySchema.parse(req.query);
        const index = await getSearchIndex(params.owner, params.repo);

        if (!index) {
            return res.status(404).json({
                error: "Search index not found. Analyze the repository first.",
            });
        }

        const results = searchIndex(index, params.q, {
            type: params.type,
            kind: params.kind,
            packageName: params.package,
            limit: params.limit,
        });

        return res.json({
            query: params.q,
            total: results.length,
            results: results.map(r => ({
                id: r.entry.id,
                type: r.entry.type,
                name: r.entry.name,
                filePath: r.entry.filePath,
                language: r.entry.language,
                kind: r.entry.kind,
                isEntryPoint: r.entry.isEntryPoint,
                isDeadCode: r.entry.isDeadCode,
                packageName: r.entry.packageName,
                score: r.score,
                matchedTokens: r.matchedTokens,
            })),
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid search parameters", details: err.issues });
        }
        next(err);
    }
});

/**
 * GET /search/symbols — search only exported symbols
 */
router.get("/symbols", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const params = searchQuerySchema.parse(req.query);
        const index = await getSearchIndex(params.owner, params.repo);

        if (!index) {
            return res.status(404).json({ error: "Search index not found." });
        }

        const results = searchIndex(index, params.q, {
            type: "export",
            kind: params.kind,
            limit: params.limit,
        });

        return res.json({
            query: params.q,
            total: results.length,
            results: results.map(r => ({
                id: r.entry.id,
                name: r.entry.name,
                filePath: r.entry.filePath,
                kind: r.entry.kind,
                score: r.score,
            })),
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid search parameters" });
        }
        next(err);
    }
});

/**
 * GET /search/files — search only files
 */
router.get("/files", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const params = searchQuerySchema.parse(req.query);
        const index = await getSearchIndex(params.owner, params.repo);

        if (!index) {
            return res.status(404).json({ error: "Search index not found." });
        }

        const results = searchIndex(index, params.q, {
            type: "file",
            kind: params.kind,
            packageName: params.package,
            limit: params.limit,
        });

        return res.json({
            query: params.q,
            total: results.length,
            results: results.map(r => ({
                id: r.entry.id,
                name: r.entry.name,
                filePath: r.entry.filePath,
                language: r.entry.language,
                kind: r.entry.kind,
                isEntryPoint: r.entry.isEntryPoint,
                isDeadCode: r.entry.isDeadCode,
                packageName: r.entry.packageName,
                score: r.score,
            })),
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid search parameters" });
        }
        next(err);
    }
});

/**
 * GET /search/issues — deterministic issue-to-code mapping
 * Query params: q (required), owner, repo, limit (optional)
 */
router.get("/issues", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const params = searchQuerySchema.parse(req.query);
        const index = await getSearchIndex(params.owner, params.repo);

        if (!index) {
            return res.status(404).json({
                error: "Search index not found. Analyze the repository first.",
            });
        }

        const result = mapIssueToCode(
            params.q,
            index,
            params.limit,
        );

        return res.json(result);
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid search parameters", details: err.issues });
        }
        next(err);
    }
});

export default router;
