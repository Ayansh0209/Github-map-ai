// backend/src/queue/processor.ts
// ─────────────────────────────────────────────────────────────────────────────
// The job processor. In production this runs SANDBOXED — BullMQ spawns it in a
// separate child process. That is the fix for "job stalled more than allowable
// limit": ts-morph parsing is synchronous CPU work, and when it ran on the
// worker's main thread it blocked the event loop, so BullMQ could not renew
// the job lock. In a sandbox, lock renewal happens in the parent process and
// can never be starved by parsing. Bonus: if this child OOMs, only the job
// fails — the API server stays up.
//
// IMPORTANT SANDBOX RULES:
//   - export default the processor function
//   - job.updateProgress() works across the process boundary; job.updateData()
//     does NOT — so progress is an object: { percent, step }
//   - this module must create its own Redis connection (it imports queue/redis,
//     not jobQueue, so no Queue instance is created in the child)
// ─────────────────────────────────────────────────────────────────────────────

import { Job } from "bullmq";
import { gzipSync, gunzipSync } from "zlib";
import path from "path";
import os from "os";
import { redisConnection } from "./redis";
import { config } from "../config/config";
import { fetchRepoMetadata } from "../github/client";
import {
    downloadTarball,
    extractTarball,
    walkFileTree,
    cleanup,
} from "../github/downlaod";
import { decideParsing } from "../processing/parseDecider";
import {
    processAllFiles,
    serializeChunkResult,
    deserializeChunkResult,
    ChunkCheckpointStore,
    SerializedChunkResult,
} from "../parser/chunkProcessor";
import { buildGraph } from "../parser/builder";
import { buildRetrievalIndex } from "../parser/retrievalBuilder";
import {
    putArtifact,
    artifactKeys,
    setLatestSha,
    storageBackend,
} from "../storage/artifactStore";

export type AnalyzeJobData = {
    repoUrl: string;
    owner: string;
    repo: string;
    jobId: string;
};

// Keep small graphs inline in the job result so the existing frontend keeps
// working; anything bigger is served from /graph/:owner/:repo (gzipped).
const INLINE_GRAPH_LIMIT_MB = 4;

// ── Cache helpers ─────────────────────────────────────────────────────────────

async function getCachedResult(cacheKey: string): Promise<object | null> {
    try {
        const cached = await redisConnection.get(cacheKey);
        if (cached) return JSON.parse(cached);
        return null;
    } catch {
        return null; // cache miss is never fatal
    }
}

async function setCachedResult(cacheKey: string, result: object): Promise<void> {
    try {
        // TTL added: results are re-derivable from artifacts; Redis must not
        // grow unbounded on a small managed instance.
        await redisConnection.set(
            cacheKey,
            JSON.stringify(result),
            "EX",
            config.artifacts.resultTtlSeconds
        );
    } catch (err) {
        console.warn("[cache] Failed to write cache:", (err as Error).message);
    }
}

// ── Checkpoint store (Redis, gzipped, short TTL) ─────────────────────────────

function makeCheckpointStore(owner: string, repo: string, sha: string): ChunkCheckpointStore & { clear: () => Promise<void> } {
    const prefix = `checkpoint:${owner}:${repo}:${sha}`;
    return {
        async load(i) {
            const buf = await redisConnection.getBuffer(`${prefix}:${i}`);
            if (!buf) return null;
            const parsed = JSON.parse(gunzipSync(buf).toString("utf-8")) as SerializedChunkResult;
            return deserializeChunkResult(parsed);
        },
        async save(i, result) {
            const gz = gzipSync(Buffer.from(JSON.stringify(serializeChunkResult(result))));
            await redisConnection.set(`${prefix}:${i}`, gz, "EX", config.artifacts.checkpointTtlSeconds);
        },
        async clear() {
            try {
                const keys = await redisConnection.keys(`${prefix}:*`);
                if (keys.length) await redisConnection.del(...keys);
            } catch {
                // best-effort — TTL cleans them anyway
            }
        },
    };
}

// ── Progress helper ───────────────────────────────────────────────────────────

async function updateProgress(job: Job<AnalyzeJobData>, percent: number, step: string): Promise<void> {
    // Object progress survives the sandbox boundary; updateData() does not.
    await job.updateProgress({ percent, step });
    console.log(`[worker] ${job.data.owner}/${job.data.repo} — ${percent}% — ${step}`);
}

// ── Main processor ────────────────────────────────────────────────────────────

export default async function processJob(job: Job<AnalyzeJobData>): Promise<object> {
    const { owner, repo, jobId } = job.data;

    console.log(`[worker] Job received: ${owner}/${repo} (jobId: ${jobId}, pid: ${process.pid}, storage: ${storageBackend()})`);

    await updateProgress(job, 0, "starting");

    // ── Step 1: Fetch repo metadata ──────────────────────────────────────────
    await updateProgress(job, 5, "fetching repository metadata");

    const metadata = await fetchRepoMetadata(owner, repo);

    // ── Step 2: Size check — abort early before downloading anything ─────────
    if (metadata.sizeMB > 500) {
        throw new Error(`Repository too large: ${metadata.sizeMB}MB (limit: 500MB)`);
    }

    console.log(
        `[worker] Metadata OK → branch=${metadata.defaultBranch}, ` +
        `sha=${metadata.commitSha.slice(0, 7)}, size=${metadata.sizeMB}MB`
    );

    // ── Step 3: Redis cache check by SHA ─────────────────────────────────────
    const cacheKey = `repo:${owner}:${repo}:${metadata.commitSha}`;
    const cached = await getCachedResult(cacheKey);

    if (cached) {
        console.log(`[worker] Cache hit for ${owner}/${repo}@${metadata.commitSha.slice(0, 7)}`);
        await updateProgress(job, 100, "done (from cache)");
        return cached;
    }

    console.log(`[worker] Cache miss — starting full analysis`);

    const checkpoints = makeCheckpointStore(owner, repo, metadata.commitSha);

    // ── Steps 4-10 run inside try/finally so cleanup ALWAYS happens ──────────
    try {
        await updateProgress(job, 10, "downloading repository");
        await downloadTarball(owner, repo, metadata.defaultBranch, jobId);

        await updateProgress(job, 25, "extracting files");
        await extractTarball(jobId);

        await updateProgress(job, 30, "walking file tree");
        const allFiles = walkFileTree(jobId);
        console.log(`[worker] Found ${allFiles.length} total files`);

        await updateProgress(job, 35, "filtering and classifying files");
        const { decisions, stats } = decideParsing(allFiles);

        console.log(
            `[worker] Parse decisions → full: ${stats.full}, imports-only: ${stats.importsOnly}, ` +
            `skipped: ${stats.skipped}, filtered: ${stats.filtered}`
        );

        if (stats.full === 0 && stats.importsOnly === 0) {
            throw new Error(
                "No parseable files found after filtering. Repository may contain no JS/TS source files."
            );
        }

        const parseableCount = stats.full + stats.importsOnly;
        if (parseableCount > 10000) {
            throw new Error(
                `Too many files to parse: ${parseableCount} (limit: 10,000). ` +
                "Repository may be a monorepo — support coming in Phase 2."
            );
        }

        // ── Step 8: Parse all files (chunked, checkpointed) ──────────────────
        await updateProgress(job, 50, "parsing files");

        const repoRoot = path.join(os.tmpdir(), "codemap", jobId);

        const { fileNodes, importEdges, allFunctions, startupSignals, routeHandlers } = await processAllFiles(
            decisions,
            repoRoot,
            (done, total) => {
                const percent = 50 + Math.floor((done / total) * 25);
                job.updateProgress({ percent, step: `parsing files (${done}/${total})` }).catch(() => { });
            },
            checkpoints
        );

        await updateProgress(job, 75, "building graph");

        // ── Step 9: Build graph ───────────────────────────────────────────────
        const { graphData, fileGraph, functionFiles, searchIndex } = buildGraph({
            owner,
            repo,
            commitSha: metadata.commitSha,
            fileNodes,
            importEdges,
            allFunctions,
            repoRoot,
            startupSignals,
            routeHandlers,
        });

        await updateProgress(job, 85, "storing graph artifacts");

        // ── Step 10: Persist artifacts (R2 or gzipped-Redis fallback) ─────────
        // The file graph — canonical copy, served via GET /graph/:owner/:repo
        await putArtifact(artifactKeys.fileGraph(owner, repo, metadata.commitSha), fileGraph);

        // Per-file functions — lazy-loaded by the frontend via POST /functions
        let funcCount = 0;
        for (const [fileId, payload] of functionFiles.entries()) {
            await putArtifact(artifactKeys.functions(owner, repo, metadata.commitSha, fileId), payload as object);
            funcCount++;
        }
        console.log(`[worker] persisted graph + ${funcCount} per-file function artifacts (${storageBackend()})`);

        await setLatestSha(owner, repo, metadata.commitSha);

        // ── Retrieval index (issue mapper) — Redis, now with TTL ──────────────
        try {
            const retrievalIndex = buildRetrievalIndex(
                owner, repo, metadata.commitSha, fileNodes, importEdges, allFunctions
            );
            await redisConnection.set(
                `retrieval:${owner}:${repo}`,
                JSON.stringify(retrievalIndex),
                "EX",
                config.artifacts.ttlSeconds
            );
            console.log(`[worker] retrieval index stored (${retrievalIndex.files.length} files)`);
        } catch (err) {
            console.warn("[worker] Failed to build/store retrieval index (non-fatal):", (err as Error).message);
        }

        // ── Search index — Redis, now with TTL ────────────────────────────────
        if (searchIndex) {
            try {
                await redisConnection.set(
                    `search:${owner}:${repo}`,
                    JSON.stringify(searchIndex),
                    "EX",
                    config.artifacts.ttlSeconds
                );
                console.log(`[worker] search index persisted (${searchIndex.entries.length} entries)`);
            } catch (err) {
                console.warn("[worker] Failed to persist search index:", (err as Error).message);
            }
        }

        // NOTE: The issue mapper / search routes used to read a second, full,
        // UNCOMPRESSED copy of the file graph from `graph:{owner}:{repo}` in
        // Redis. That duplicated the gzipped fileGraph artifact (R2/Redis) and
        // was a primary cause of Redis OOM. It is now removed — those routes
        // read the graph via getFileGraph() (artifact store, R2-first) instead.

        // ── Step 11: Build the (slim) result ──────────────────────────────────
        // Small graphs stay inline so the current frontend works unchanged;
        // big graphs are fetched from /graph/:owner/:repo (gzipped).
        const graphJson = JSON.stringify(fileGraph);
        const graphSizeMB = Buffer.byteLength(graphJson, "utf8") / 1024 / 1024;
        const inlineGraph = graphSizeMB <= INLINE_GRAPH_LIMIT_MB ? fileGraph : null;

        if (!inlineGraph) {
            console.log(
                `[worker] fileGraph is ${graphSizeMB.toFixed(2)}MB (> ${INLINE_GRAPH_LIMIT_MB}MB) — ` +
                `omitted from result; frontend must fetch /graph/${owner}/${repo}`
            );
        }

        const result = {
            success: true,
            owner,
            repo,
            commitSha: metadata.commitSha,
            defaultBranch: metadata.defaultBranch,
            sizeMb: metadata.sizeMB,
            stats: graphData.stats,
            graphSizeMb: Number(graphSizeMB.toFixed(2)),
            // Where the frontend can always get the graph (gzipped):
            fileGraphUrl: `/graph/${owner}/${repo}?sha=${metadata.commitSha}`,
            // Functions are always lazy-loaded per file:
            functionsBaseUrl: `/functions`,
            // Inline only when small (backwards compatibility):
            _inlineFileGraph: inlineGraph,
            // Per-file functions are NEVER inlined anymore (was an OOM source):
            _functionFiles: {},
        };

        await setCachedResult(cacheKey, result);

        // Success — checkpoints no longer needed
        await checkpoints.clear();

        await updateProgress(job, 100, "done");

        return result;

    } finally {
        // Cleanup ALWAYS runs — disk never fills up regardless of what goes wrong
        cleanup(jobId);
    }
}
