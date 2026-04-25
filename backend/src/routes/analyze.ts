// backend/src/routes/analyze.ts

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { jobQueue } from "../queue/jobQueue";
import { config } from "../config/config";

const router = Router();

const analyzeSchema = z.object({
    repoUrl: z
        .string()
        .regex(
            /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/,
            "Must be a valid GitHub repo URL: https://github.com/{owner}/{repo}"
        ),
});

function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } {
    const parts = repoUrl.replace("https://github.com/", "").split("/");
    return { owner: parts[0], repo: parts[1] };
}

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { repoUrl } = analyzeSchema.parse(req.body);

        // Check queue depth — no network calls, just Redis
        const counts = await jobQueue.getJobCounts("waiting", "active");
        const totalActive = (counts.waiting ?? 0) + (counts.active ?? 0);

        if (totalActive >= config.queue.maxQueueSize) {
            return res.status(503).json({
                error: "Server is busy. Try again in a few minutes.",
                queueDepth: totalActive,
            });
        }

        const { owner, repo } = parseOwnerRepo(repoUrl);
        const jobId = randomUUID();

        const job = await jobQueue.add(
            "analyze",
            { repoUrl, owner, repo, jobId },
            { jobId }  // use our own UUID as BullMQ job ID
        );

        const waitingCount = counts.waiting ?? 0;

        return res.status(202).json({
            jobId: job.id,
            position: waitingCount + 1,
            estimatedWaitMs: (waitingCount + 1) * 60000,  // rough estimate
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({
                error: "Invalid request",
                details: err.flatten().fieldErrors,
            });
        }
        next(err);
    }
});

export default router;