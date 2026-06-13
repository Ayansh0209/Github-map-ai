import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing env variable: ${name}`);
    }
    return value;
}

function optional(name: string): string {
    return process.env[name] ?? "";
}

export const config = {
    app: {
        port: Number(process.env.PORT || 5000),
    },

    redis: {
        url: required("REDIS_URL"),
    },

    github: {
        token: required("GITHUB_TOKEN"),
    },

    r2: {
        accountId: optional("R2_ACCOUNT_ID"),
        accessKeyId: optional("R2_ACCESS_KEY_ID"),
        secretAccessKey: optional("R2_SECRET_ACCESS_KEY"),
        bucketName: optional("R2_BUCKET_NAME"),
        publicUrl: optional("R2_PUBLIC_URL"),
        // Generic S3 endpoint — set this to use ANY S3-compatible provider
        // (Cloudflare R2, Backblaze B2, Supabase Storage, Storj, Wasabi, MinIO).
        // When set, it takes precedence over the R2 accountId-derived endpoint.
        endpoint: optional("R2_ENDPOINT"),
        region: optional("R2_REGION"), // default "auto" (R2); B2/Supabase need a real region
    },

    queue: {
        // Default 1: parsing is CPU+RAM heavy — raise via env on bigger machines
        maxConcurrentJobs: Number(process.env.MAX_CONCURRENT_JOBS || 1),
        maxQueueSize: Number(process.env.MAX_QUEUE_SIZE || 100),
        jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS || 600000),
        // Lock tuning — generous lock so long CPU bursts never look "stalled"
        lockDurationMs: Number(process.env.LOCK_DURATION_MS || 120000),
        stalledIntervalMs: Number(process.env.STALLED_INTERVAL_MS || 60000),
        maxStalledCount: Number(process.env.MAX_STALLED_COUNT || 2),
        // Files per ts-morph chunk — lower = flatter RAM, slightly slower
        parseChunkSize: Number(process.env.PARSE_CHUNK_SIZE || 20),
    },

    artifacts: {
        // TTL for the Redis fallback store (R2 objects have no TTL)
        ttlSeconds: Number(process.env.ARTIFACT_TTL_SECONDS || 7 * 86400),
        // TTL for resumable parse checkpoints
        checkpointTtlSeconds: Number(process.env.CHECKPOINT_TTL_SECONDS || 2 * 3600),
        // TTL for the cached final result (keyed by immutable SHA)
        resultTtlSeconds: Number(process.env.RESULT_TTL_SECONDS || 7 * 86400),
    },

    gemini: {
        apiKey: optional("GEMINI_API_KEY"),
    },

    chat: {
        enableIterativeRetrieval: process.env.ENABLE_ITERATIVE_CHAT_RETRIEVAL === "true",
    },

    gcp: {
        projectId: optional("GCP_PROJECT_ID"),
        location: optional("GCP_LOCATION"),
    },
};
