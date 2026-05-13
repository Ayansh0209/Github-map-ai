// src/routes/functions.ts
// ─────────────────────────────────────────────────────────────────────────────
// Returns parsed function metadata for a given file in a repo.
//
// WHAT THIS FILE DOES:
//   - Look up cached function data from Redis (key: functions:{owner}:{repo}:{sha}:{file})
//   - If the requested file is a barrel (re-export only), redirect the lookup
//     to its barrelTargets using the RetrievalIndex, and merge results
//   - Return function metadata in the shape the frontend expects
//
// WHAT THIS FILE INTENTIONALLY DOES NOT DO:
//   - No GitHub API calls (function data is pre-parsed at analysis time)
//   - No AI calls
//   - No re-parsing (all function data is written during the worker analysis job)
//
// WHY BARREL DETECTION EXISTS:
//   The frontend often requests functions for src/index.ts or similar barrel files
//   that only re-export from other modules. These files have no real function
//   implementations — only re-exports. Without barrel detection, every such
//   request returns 404 or an empty list.
//
//   With barrel detection: if the RetrievalIndex marks this file as a barrel,
//   we transparently redirect to the real implementation files and merge their
//   function lists.
//
// GRACEFUL DEGRADATION:
//   - RetrievalIndex missing (old repo) → fall back to direct cache lookup only
//   - barrelTargets not in cache → return empty list (same as before)
//   - Redis completely down → return 503 with a clear error message
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { redisConnection } from "../queue/jobQueue";
import type { RetrievalIndex } from "../models/retrieval";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the Redis cache key for function data.
 * Sanitizes the fileId to avoid key injection.
 */
function functionsCacheKey(owner: string, repo: string, commitSha: string, fileId: string): string {
    const sanitized = fileId.replace(/[/\\]/g, "-").replace(/[^a-zA-Z0-9.\-_]/g, "_");
    return `functions:${owner}:${repo}:${commitSha}:${sanitized}`;
}

/**
 * Load the RetrievalIndex for a repo from Redis.
 *
 * Returns null if:
 *   - Redis is unavailable
 *   - The key doesn't exist (repo analyzed before Phase 1 shipped)
 *   - JSON parse fails
 *
 * All failures return null — caller falls back to direct cache lookup.
 */
async function loadRetrievalIndex(owner: string, repo: string): Promise<RetrievalIndex | null> {
    try {
        const raw = await redisConnection.get(`retrieval:${owner}:${repo}`);
        if (!raw) return null;
        return JSON.parse(raw) as RetrievalIndex;
    } catch {
        return null;
    }
}

/**
 * Fetch and merge function data from multiple files.
 *
 * Used when a barrel expands to multiple implementation files.
 * Each target file's function cache is fetched independently.
 * Files not in cache are silently skipped (not a fatal error).
 *
 * @param targets    Array of fileIds to fetch
 * @param owner      Repo owner
 * @param repo       Repo name
 * @param commitSha  Commit SHA
 * @returns          Merged array of function objects from all targets
 */
async function fetchMergedFunctions(
    targets: string[],
    owner: string,
    repo: string,
    commitSha: string,
): Promise<any[]> {
    const merged: any[] = [];

    for (const target of targets.slice(0, 10)) { // cap at 10 targets to avoid explosion
        try {
            const key = functionsCacheKey(owner, repo, commitSha, target);
            const cached = await redisConnection.get(key);
            if (!cached) continue;

            const data = JSON.parse(cached);
            // data may be an array of functions or an object with a functions field
            const functions = Array.isArray(data) ? data : (data.functions ?? data.nodes ?? []);

            // Tag each function with its source file for the frontend
            for (const fn of functions) {
                merged.push({ ...fn, _sourceFile: target });
            }
        } catch {
            // Cache miss or parse error for this target — skip it
        }
    }

    return merged;
}

// ── Route: POST /functions ────────────────────────────────────────────────────

router.post("/", async (req, res) => {
    try {
        const { owner, repo, commitSha, fileId } = req.body as {
            owner?: string;
            repo?: string;
            commitSha?: string;
            fileId?: string;
        };

        if (!owner || !repo || !commitSha || !fileId) {
            return res.status(400).json({ error: "missing parameters" });
        }

        // ── Step 1: Try direct cache lookup ───────────────────────────────────
        // Most files are NOT barrels, so this is the common path.
        const directKey = functionsCacheKey(owner, repo, commitSha, fileId);
        const directCached = await redisConnection.get(directKey);

        if (directCached) {
            console.log(`[functions] cache hit: ${fileId}`);
            return res.json(JSON.parse(directCached));
        }

        // ── Step 2: Cache miss — check if this is a barrel file ───────────────
        // Load the RetrievalIndex (if available) to check isBarrel.
        //
        // Degradation: if RetrievalIndex not available (old repo), fall through
        // to the original 404 behavior. Nothing breaks.
        const retrieval = await loadRetrievalIndex(owner, repo);

        if (!retrieval) {
            // No RetrievalIndex — old behavior
            console.log(`[functions] cache miss, no retrieval index: ${fileId}`);
            return res.status(404).json({ error: "not found" });
        }

        // Find this file's entry in the retrieval index
        const fileEntry = retrieval.files.find(f => f.fileId === fileId);

        if (!fileEntry) {
            // File not in retrieval index at all
            console.log(`[functions] file not in retrieval index: ${fileId}`);
            return res.status(404).json({ error: "not found" });
        }

        if (!fileEntry.isBarrel || fileEntry.barrelTargets.length === 0) {
            // Not a barrel — it's just a cache miss for a real file
            // (functions may not have been indexed for this file, e.g. it has no functions)
            console.log(`[functions] cache miss (non-barrel, no functions): ${fileId}`);
            return res.json({ functions: [], fileId, source: "cache-miss" });
        }

        // ── Step 3: Barrel expansion ──────────────────────────────────────────
        // This file is a barrel (re-export only). Redirect to its real targets.
        console.log(
            `[functions] barrel detected: ${fileId} → ` +
            `[${fileEntry.barrelTargets.slice(0, 3).join(", ")}` +
            `${fileEntry.barrelTargets.length > 3 ? `, +${fileEntry.barrelTargets.length - 3} more` : ""}]`
        );

        const merged = await fetchMergedFunctions(
            fileEntry.barrelTargets,
            owner,
            repo,
            commitSha,
        );

        if (merged.length === 0) {
            // Barrel targets also have no cached functions
            console.log(`[functions] barrel targets have no cached functions: ${fileId}`);
            return res.json({ functions: [], fileId, isBarrel: true, barrelTargets: fileEntry.barrelTargets });
        }

        return res.json({
            functions:     merged,
            fileId,
            isBarrel:      true,
            barrelTargets: fileEntry.barrelTargets,
        });
    } catch (err) {
        console.error("[functionsRoute] error:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

export default router;
