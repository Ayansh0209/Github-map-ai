// backend/src/scripts/redisCleanup.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME (and safe-to-repeat) Redis cleanup for the OOM situation.
//
// WHAT IT REMOVES:
//   • graph:*      → the legacy, UNCOMPRESSED full file-graph copies. No longer
//                    written (the issue mapper/search now read via the artifact
//                    store), and re-derivable by re-analyzing. Always safe.
//   • artifact:*   → the gzipped Redis-fallback artifacts. These become dead
//                    weight ONCE R2 is configured (the canonical store). Only
//                    removed when R2 is configured, OR when you pass
//                    --include-artifacts to force it.
//
// WHAT IT NEVER TOUCHES:
//   • bull:*       → live BullMQ queue / job / lock state. Deleting these would
//                    corrupt the queue, so they are hard-excluded.
//   • Everything else (cache, retrieval, search, latest-sha, telemetry) is
//     left alone — those are small and already TTL'd.
//
// USAGE (run from backend/):
//   npx ts-node src/scripts/redisCleanup.ts --dry-run     # preview only
//   npx ts-node src/scripts/redisCleanup.ts               # delete graph:* (+ artifact:* if R2 set)
//   npx ts-node src/scripts/redisCleanup.ts --include-artifacts
//
// In production (compiled): node dist/scripts/redisCleanup.js [flags]
// ─────────────────────────────────────────────────────────────────────────────

import { redisConnection } from "../queue/redis";
import { config } from "../config/config";

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE_ARTIFACTS = process.argv.includes("--include-artifacts");

function r2Configured(): boolean {
    return Boolean(
        config.r2.accountId &&
        config.r2.accessKeyId &&
        config.r2.secretAccessKey &&
        config.r2.bucketName
    );
}

// Scan (non-blocking) for keys matching a glob and return them in batches.
async function scanKeys(match: string): Promise<string[]> {
    const found: string[] = [];
    return new Promise((resolve, reject) => {
        const stream = (redisConnection as any).scanStream({ match, count: 200 });
        stream.on("data", (keys: string[]) => {
            for (const k of keys) {
                if (k.startsWith("bull:")) continue; // hard safety: never queue keys
                found.push(k);
            }
        });
        stream.on("end", () => resolve(found));
        stream.on("error", reject);
    });
}

// Best-effort memory accounting via MEMORY USAGE (skips silently if unsupported).
async function approxBytes(keys: string[]): Promise<number> {
    let total = 0;
    for (const k of keys) {
        try {
            const n = await (redisConnection as any).memory("USAGE", k);
            if (typeof n === "number") total += n;
        } catch {
            // MEMORY USAGE not available on this managed Redis — skip sizing
        }
    }
    return total;
}

async function deleteInBatches(keys: string[]): Promise<number> {
    let deleted = 0;
    const BATCH = 500;
    for (let i = 0; i < keys.length; i += BATCH) {
        const batch = keys.slice(i, i + BATCH);
        if (!batch.length) continue;
        deleted += await redisConnection.del(...batch);
    }
    return deleted;
}

function mb(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
    console.log("──────────────────────────────────────────────");
    console.log(`Redis cleanup  ${DRY_RUN ? "(DRY RUN — nothing will be deleted)" : "(LIVE)"}`);
    console.log(`R2 configured: ${r2Configured() ? "yes" : "no"}`);
    console.log("──────────────────────────────────────────────");

    // 1) Legacy uncompressed graph copies — always removable.
    const graphKeys = await scanKeys("graph:*");
    const graphBytes = await approxBytes(graphKeys);
    console.log(`graph:*      ${graphKeys.length} keys  (~${mb(graphBytes)})  → ${DRY_RUN ? "would delete" : "deleting"}`);

    // 2) Redis-fallback artifacts — only when R2 is the canonical store now.
    const removeArtifacts = r2Configured() || FORCE_ARTIFACTS;
    let artifactKeys: string[] = [];
    let artifactBytes = 0;
    if (removeArtifacts) {
        artifactKeys = await scanKeys("artifact:*");
        artifactBytes = await approxBytes(artifactKeys);
        console.log(`artifact:*   ${artifactKeys.length} keys  (~${mb(artifactBytes)})  → ${DRY_RUN ? "would delete" : "deleting"}`);
    } else {
        console.log("artifact:*   SKIPPED — R2 not configured (these are your live store).");
        console.log("             Re-run with --include-artifacts only after R2 is set up.");
    }

    if (!DRY_RUN) {
        const all = [...graphKeys, ...artifactKeys];
        const deleted = await deleteInBatches(all);
        console.log("──────────────────────────────────────────────");
        console.log(`Deleted ${deleted} keys, freed ~${mb(graphBytes + artifactBytes)}.`);
    } else {
        console.log("──────────────────────────────────────────────");
        console.log(`Would delete ${graphKeys.length + artifactKeys.length} keys, freeing ~${mb(graphBytes + artifactBytes)}.`);
    }

    await redisConnection.quit();
    process.exit(0);
}

main().catch((err) => {
    console.error("[redisCleanup] failed:", err);
    process.exit(1);
});
