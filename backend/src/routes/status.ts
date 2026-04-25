// backend/src/routes/status.ts

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { jobQueue } from "../queue/jobQueue";

const router = Router();

const jobIdSchema = z.string().regex(/^[a-zA-Z0-9-]{1,64}$/, "Invalid jobId");

router.get("/:jobId", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const jobId = jobIdSchema.parse(req.params.jobId);

        const job = await jobQueue.getJob(jobId);

        if (!job) {
            return res.status(404).json({ error: "Job not found" });
        }

        const state = await job.getState();

        switch (state) {
            case "waiting":
            case "delayed": {
                // BullMQ does not have a native job.getPosition() method.
                // For "waiting" jobs, we can find the index in the waiting list.
                let position = 0;
                if (state === "waiting") {
                    const waitingJobs = await jobQueue.getWaiting();
                    const index = waitingJobs.findIndex(j => j.id === jobId);
                    position = index !== -1 ? index + 1 : 0;
                }

                return res.json({
                    status: state === "waiting" ? "queued" : "delayed",
                    position,
                });
            }

            case "active": {
                return res.json({
                    status: "processing",
                    progress: job.progress,
                    step: (job.data as any).currentStep ?? "processing",
                });
            }

            case "completed": {
                return res.json({
                    status: "done",
                    ...(job.returnvalue as object),
                });
            }

            case "failed": {
                return res.json({
                    status: "failed",
                    error: job.failedReason ?? "Unknown error",
                });
            }

            default:
                return res.json({ status: state });
        }
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid job ID" });
        }
        next(err);
    }
});

export default router;