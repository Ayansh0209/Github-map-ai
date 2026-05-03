import { Router, Request, Response } from "express";
import { z } from "zod";
import Redis from "ioredis";
import { config } from "../config/config";

const router = Router();

const redis = new Redis(config.redis.url, { maxRetriesPerRequest: 3 });

const FileContentSchema = z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    commitSha: z.string().min(6),
    filePath: z.string().min(1),
});

router.post("/", async (req: Request, res: Response) => {
    const parsed = FileContentSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        return;
    }

    const { owner, repo, commitSha, filePath } = parsed.data;
    const cacheKey = `file-content:${owner}:${repo}:${commitSha}:${filePath}`;

    try {
        // Check Redis cache first
        const cached = await redis.get(cacheKey);
        if (cached !== null) {
            const lines = cached.split("\n").length;
            res.json({ content: cached, lines });
            return;
        }

        // Fetch from GitHub raw
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${filePath}`;
        const headers: Record<string, string> = {};
        if (config.github.token) {
            headers["Authorization"] = `Bearer ${config.github.token}`;
        }

        const ghRes = await fetch(url, { headers });

        if (ghRes.status === 404) {
            res.json({ content: null, lines: 0 });
            return;
        }

        if (!ghRes.ok) {
            res.status(502).json({ error: `GitHub returned ${ghRes.status}` });
            return;
        }

        const content = await ghRes.text();
        const lines = content.split("\n").length;

        // Cache forever (commitSha is immutable)
        await redis.set(cacheKey, content).catch(() => {});

        res.json({ content, lines });
    } catch (err) {
        console.error("[fileContent] Error:", err);
        res.status(500).json({ error: "Failed to fetch file content" });
    }
});

export default router;
