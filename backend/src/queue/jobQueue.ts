// backend/src/queue/jobQueue.ts

import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config/config"

// Shared IORedis connection — reuse across Queue + Worker
// BullMQ requires Redis binary protocol, NOT Upstash REST
export const redisConnection = new IORedis(config.redis.url, {
    maxRetriesPerRequest: null,   // required by BullMQ
    enableReadyCheck: false,      // required by BullMQ
    lazyConnect: false,
    retryStrategy(times) {
        // Wait 5 seconds between reconnect attempts to avoid spam
        return 5000;
    }
});

let lastErrorTime = 0;
redisConnection.on("error", (err: any) => {
    // Only print the error once every 5 seconds to prevent infinite terminal spam
    if (Date.now() - lastErrorTime >= 5000) {
        console.error(`\x1b[31m[redis] Connection Refused: Could not connect to Redis at ${config.redis.url}\x1b[0m`);
        console.error(`\x1b[33m-> If running locally, make sure you have started a Redis server (e.g. docker run -p 6379:6379 redis)\x1b[0m`);
        lastErrorTime = Date.now();
    }
});

redisConnection.on("connect", () => {
    console.log("[redis] connected to Railway Redis");
});

export const jobQueue = new Queue("repo-analysis", {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 2,
        backoff: {
            type: "fixed",
            delay: 5000,
        },
        removeOnComplete: { count: 100 },   // keep last 100 completed jobs
        removeOnFail: { count: 50 },        // keep last 50 failed jobs for debugging
    },
});