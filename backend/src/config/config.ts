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
    },

    queue: {
        maxConcurrentJobs: Number(process.env.MAX_CONCURRENT_JOBS || 3),
        maxQueueSize: Number(process.env.MAX_QUEUE_SIZE || 100),
        jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS || 600000),
    }
};