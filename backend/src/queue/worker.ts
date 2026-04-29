// backend/src/queue/worker.ts

import { Worker, Job } from "bullmq";
import { redisConnection } from "./jobQueue";
import { config } from "../config/config";
import { fetchRepoMetadata } from "../github/client";
import {
    downloadTarball,
    extractTarball,
    walkFileTree,
    cleanup,
} from "../github/downlaod";
import { decideParsing } from "../processing/parseDecider";
import { processAllFiles } from "../parser/chunkProcessor";
import path from "path";
import os from "os";
type AnalyzeJobData = {
    repoUrl: string;
    owner: string;
    repo: string;
    jobId: string;
    currentStep?: string;
};

// ── Cache helpers (uses same Railway Redis, no extra file needed yet) ──────────

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
        // No TTL — SHA is immutable, result never changes
        await redisConnection.set(cacheKey, JSON.stringify(result));
    } catch (err) {
        // Cache write failure is never fatal — job still succeeds
        console.warn("[cache] Failed to write cache:", (err as Error).message);
    }
}

// ── Progress helper ────────────────────────────────────────────────────────────

async function updateProgress(
    job: Job<AnalyzeJobData>,
    percent: number,
    step: string
): Promise<void> {
    await job.updateProgress(percent);
    await job.updateData({ ...job.data, currentStep: step });
    console.log(`[worker] ${job.data.owner}/${job.data.repo} — ${percent}% — ${step}`);
}

// ── Main processor ─────────────────────────────────────────────────────────────

async function processJob(job: Job<AnalyzeJobData>): Promise<object> {
    const { owner, repo, jobId } = job.data;

    console.log(`[worker] Job received: ${owner}/${repo} (jobId: ${jobId})`);

    await updateProgress(job, 0, "starting");

    // ── Step 1: Fetch repo metadata ──────────────────────────────────────────
    await updateProgress(job, 5, "fetching repository metadata");

    const metadata = await fetchRepoMetadata(owner, repo);

    // ── Step 2: Size check — abort early before downloading anything ─────────
    if (metadata.sizeMB > 500) {
        throw new Error(
            `Repository too large: ${metadata.sizeMB}MB (limit: 500MB)`
        );
    }

    console.log(
        `[worker] Metadata OK → branch=${metadata.defaultBranch}, ` +
        `sha=${metadata.commitSha.slice(0, 7)}, size=${metadata.sizeMB}MB`
    );

    // ── Step 3: Redis cache check by SHA ─────────────────────────────────────
    // Same SHA always produces same graph — never reprocess
    const cacheKey = `repo:${owner}:${repo}:${metadata.commitSha}`;
    const cached = await getCachedResult(cacheKey);

    if (cached) {
        console.log(`[worker] Cache hit for ${owner}/${repo}@${metadata.commitSha.slice(0, 7)}`);
        await updateProgress(job, 100, "done (from cache)");
        return cached;
    }

    console.log(`[worker] Cache miss — starting full analysis`);

    // ── Steps 4-8 run inside try/finally so cleanup ALWAYS happens ───────────
    try {
        // ── Step 4: Download tarball (streaming, never loads into RAM) ───────
        await updateProgress(job, 10, "downloading repository");

        await downloadTarball(owner, repo, metadata.defaultBranch, jobId);

        // ── Step 5: Extract tarball ───────────────────────────────────────────
        await updateProgress(job, 25, "extracting files");

        await extractTarball(jobId);

        // ── Step 6: Walk file tree ────────────────────────────────────────────
        await updateProgress(job, 30, "walking file tree");

        const allFiles = walkFileTree(jobId);

        console.log(`[worker] Found ${allFiles.length} total files`);

        // ── Step 7: Filter + decide parse mode per file ───────────────────────
        await updateProgress(job, 35, "filtering and classifying files");

        const { decisions, stats } = decideParsing(allFiles);

        console.log(
            `[worker] Parse decisions → ` +
            `full: ${stats.full}, ` +
            `imports-only: ${stats.importsOnly}, ` +
            `skipped: ${stats.skipped}, ` +
            `filtered: ${stats.filtered}`
        );

        // Guard: abort if no parseable files found
        if (stats.full === 0 && stats.importsOnly === 0) {
            throw new Error(
                "No parseable files found after filtering. " +
                "Repository may contain no JS/TS source files."
            );
        }

        // Guard: abort if file count is unreasonably large
        const parseableCount = stats.full + stats.importsOnly;
        if (parseableCount > 10000) {
            throw new Error(
                `Too many files to parse: ${parseableCount} (limit: 10,000). ` +
                "Repository may be a monorepo — support coming in Phase 2."
            );
        }

        // ── Steps 8-10 added in Layer 5 (ts-morph) and Layer 6 (graph builder)
        // ── Step 8: Parse all files with ts-morph ────────────────────────────────
        await updateProgress(job, 50, "parsing files");

        // repoRoot is the extracted folder — needed for import resolution
        const repoRoot = path.join(os.tmpdir(), "codemap", jobId);

        const { fileNodes, importEdges, allFunctions } = await processAllFiles(
            decisions,
            repoRoot,
            (done, total) => {
                // map 50→75% progress across parsing
                const percent = 50 + Math.floor((done / total) * 25);
                job.updateProgress(percent);
            }
        );

        await updateProgress(job, 75, "parsing complete");
        // Placeholder result for now — replaced when those layers are built
        const result = {
            success: true,
            owner,
            repo,
            commitSha: metadata.commitSha,
            defaultBranch: metadata.defaultBranch,
            sizeMb: metadata.sizeMB,
            stats: {
                totalFiles: fileNodes.length,
                totalFunctions: allFunctions.length,
                totalImportEdges: importEdges.length,
            },
            // These will be real R2 URLs once Layer 7 (storage) is built
            fileGraphUrl: null,
            functionsBaseUrl: null,
        };

        // ── Cache the result so same SHA is never reprocessed ─────────────────
        await setCachedResult(cacheKey, result);

        await updateProgress(job, 100, "done");

        return result;

    } finally {
        // ── Cleanup ALWAYS runs — even if job throws halfway through ──────────
        // Disk never fills up regardless of what goes wrong
        cleanup(jobId);
    }
}

// ── Worker setup ──────────────────────────────────────────────────────────────

export const analysisWorker = new Worker<AnalyzeJobData>(
    "repo-analysis",
    processJob,
    {
        connection: redisConnection,
        concurrency: config.queue.maxConcurrentJobs,
    }
);

analysisWorker.on("active", (job) => {
    console.log(`[worker] Job active: ${job.id} — ${job.data.owner}/${job.data.repo}`);
});

analysisWorker.on("completed", (job, result) => {
    console.log(`[worker] Job completed: ${job.id}`);
    console.log(`[worker] Result:`, JSON.stringify(result, null, 2));
});

analysisWorker.on("failed", (job, err) => {
    console.error(`[worker] Job failed: ${job?.id} — ${err.message}`);
});

analysisWorker.on("error", (err) => {
    console.error(`[worker] Worker error: ${err.message}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Waits for active jobs to finish before process exits
// Railway sends SIGTERM before killing the container

async function shutdown(): Promise<void> {
    console.log("[worker] Shutting down gracefully...");
    await analysisWorker.close();
    await redisConnection.quit();
    process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(
    `[worker] Started — concurrency: ${config.queue.maxConcurrentJobs}`
);