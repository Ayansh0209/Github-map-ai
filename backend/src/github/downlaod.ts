import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import tar from "tar";
import { config } from "../config/config";

const TMP_BASE = "/tmp/codemap";
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max download time

// ── Helpers ─────────────────────────────────────────────

function getTarPath(jobId: string): string {
    return path.join(TMP_BASE, `${jobId}.tar.gz`);
}

function getExtractPath(jobId: string): string {
    return path.join(TMP_BASE, jobId);
}

function ensureDir(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
}

// ── Download ─────────────────────────────────────────────

export async function downloadTarball(
    owner: string,
    repo: string,
    branch: string,
    jobId: string
): Promise<string> {

    const tarPath = getTarPath(jobId);
    ensureDir(TMP_BASE); // make sure /tmp/codemap exists

    const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${branch}`;

    // abort controller gives us download timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, DOWNLOAD_TIMEOUT_MS);

    try {
        const res = await fetch(url, {
            headers: {
                Authorization: `Bearer ${config.github.token}`,
                Accept: "application/vnd.github+json",
                "User-Agent": "codemap-ai",
            },
            signal: controller.signal,
        });

        if (!res.ok) {
            throw new Error(
                `GitHub tarball download failed: ${res.status} ${res.statusText}`
            );
        }

        if (!res.body) {
            throw new Error("No response body from GitHub");
        }

        // stream directly to disk - never loads into RAM
        // pipeline() handles backpressure automatically
        await pipeline(
            Readable.fromWeb(res.body as any),
            fs.createWriteStream(tarPath)
        );

        return tarPath;

    } catch (err: any) {
        // clean up partial file if download failed
        if (fs.existsSync(tarPath)) {
            fs.unlinkSync(tarPath);
        }
        if (err.name === "AbortError") {
            throw new Error("Tarball download timed out after 5 minutes");
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

// ── Extract ──────────────────────────────────────────────

export async function extractTarball(jobId: string): Promise<string> {
    const tarPath = getTarPath(jobId);
    const extractPath = getExtractPath(jobId);

    // create extract directory
    ensureDir(extractPath);

    try {
        // strip: 1 removes the top level github folder
        // github tarballs have format: owner-repo-sha/...files
        // strip: 1 makes it just: ...files
        await tar.x({
            file: tarPath,
            cwd: extractPath,
            strip: 1,
        });

        // delete tar.gz immediately after extraction
        // no point keeping it, saves disk space
        fs.unlinkSync(tarPath);

        return extractPath;

    } catch (err) {
        // clean up on failure
        cleanup(jobId);
        throw new Error(`Failed to extract tarball: ${(err as Error).message}`);
    }
}

// ── Walk File Tree ───────────────────────────────────────

export interface FileEntry {
    absolutePath: string;
    relativePath: string;
    sizeBytes: number;
}

export function walkFileTree(jobId: string): FileEntry[] {
    const extractPath = getExtractPath(jobId);
    const results: FileEntry[] = [];

    function walk(currentDir: string): void {
        let items: string[];

        try {
            items = fs.readdirSync(currentDir);
        } catch {
            // skip unreadable directories silently
            return;
        }

        for (const item of items) {
            const fullPath = path.join(currentDir, item);

            let stat: fs.Stats;
            try {
                stat = fs.statSync(fullPath);
            } catch {
                // skip broken symlinks or unreadable files
                continue;
            }

            // skip symlinks - can cause infinite loops
            if (stat.isSymbolicLink()) continue;

            if (stat.isDirectory()) {
                walk(fullPath);
            } else if (stat.isFile()) {
                results.push({
                    absolutePath: fullPath,
                    // relative path from repo root - used as node ID in graph
                    relativePath: path.relative(extractPath, fullPath),
                    sizeBytes: stat.size,
                });
            }
        }
    }

    walk(extractPath);
    return results;
}

// ── Cleanup ──────────────────────────────────────────────

export function cleanup(jobId: string): void {
    const extractPath = getExtractPath(jobId);
    const tarPath = getTarPath(jobId);

    // remove extracted folder
    if (fs.existsSync(extractPath)) {
        fs.rmSync(extractPath, { recursive: true, force: true });
    }

    // remove tar if somehow still exists
    if (fs.existsSync(tarPath)) {
        fs.unlinkSync(tarPath);
    }

    console.log(`[cleanup] ${jobId} removed from disk`);
}