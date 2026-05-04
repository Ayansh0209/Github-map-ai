import { Router } from "express";
import { redisConnection } from "../queue/jobQueue";

const router = Router();

// Route: POST /functions
router.post("/", async (req, res) => {
    try {
        const { owner, repo, commitSha, fileId } = req.body;

        if (!owner || !repo || !commitSha || !fileId) {
            return res.status(400).json({ error: "missing parameters" });
        }

        const sanitizedId = fileId.replace(/[/\\]/g, "-").replace(/[^a-zA-Z0-9.\-_]/g, "_");
        const cacheKey = `functions:${owner}:${repo}:${commitSha}:${sanitizedId}`;

        const cached = await redisConnection.get(cacheKey);

        if (!cached) {
            return res.status(404).json({ error: "not found" });
        }

        return res.json(JSON.parse(cached));
    } catch (err) {
        console.error("[functionsRoute] error:", err);
        return res.status(500).json({ error: "Server error" });
    }
});

export default router;
