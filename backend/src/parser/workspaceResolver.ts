// src/parser/workspaceResolver.ts
// ─────────────────────────────────────────────────────────────────────────────
// Deterministic monorepo / workspace detection.
//
// Detects workspace boundaries by scanning for:
//   1. pnpm-workspace.yaml
//   2. turbo.json
//   3. nx.json
//   4. lerna.json
//   5. package.json "workspaces" field (npm/yarn)
//   6. Nested package.json roots
//
// For each discovered package, maps its name → root directory so that:
//   - builder.ts can tag each FileNode with its parent package
//   - cross-package import edges can be identified
// ─────────────────────────────────────────────────────────────────────────────

import fs   from "fs";
import path from "path";
import type { WorkspaceInfo, WorkspacePackageInfo } from "../models/schema";

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeReadJson(filePath: string): Record<string, unknown> | null {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const stripped = raw
            .replace(/\/\/.*$/gm, "")
            .replace(/\/\*[\s\S]*?\*\//g, "");
        return JSON.parse(stripped) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function safeReadText(filePath: string): string | null {
    try {
        return fs.readFileSync(filePath, "utf-8");
    } catch {
        return null;
    }
}

/**
 * Expand a workspace glob pattern into actual directories on disk.
 * Handles patterns like "packages/*", "apps/*", "libs/**".
 * Only expands one level of wildcards — no deep recursion to stay performant.
 */
function expandWorkspaceGlob(repoRoot: string, pattern: string): string[] {
    // Strip trailing /* or /** — we just want the parent directory
    const cleaned = pattern.replace(/\/\*\*?$/, "").replace(/\*$/, "");
    const parentDir = path.resolve(repoRoot, cleaned);

    if (!fs.existsSync(parentDir)) return [];

    try {
        const stat = fs.statSync(parentDir);
        // If the pattern is a direct path (no wildcard), return it directly
        if (!pattern.includes("*") && stat.isDirectory()) {
            return [parentDir];
        }
    } catch { /* fall through to scan children */ }

    // Scan children of the parent dir
    const results: string[] = [];
    try {
        const entries = fs.readdirSync(parentDir);
        for (const entry of entries) {
            if (entry.startsWith(".") || entry === "node_modules") continue;
            const full = path.join(parentDir, entry);
            try {
                if (fs.statSync(full).isDirectory()) {
                    results.push(full);
                }
            } catch { continue; }
        }
    } catch { /* empty */ }

    return results;
}

/**
 * Read a package.json inside a directory and extract package info.
 * Returns null if no valid package.json exists.
 */
function readPackageInfo(
    pkgDir: string,
    repoRoot: string,
    allPkgNames: Set<string>
): WorkspacePackageInfo | null {
    const pkgJsonPath = path.join(pkgDir, "package.json");
    const parsed = safeReadJson(pkgJsonPath);
    if (!parsed || typeof parsed.name !== "string") return null;

    const name = parsed.name as string;
    const version = typeof parsed.version === "string" ? parsed.version : undefined;
    const isPrivate = parsed.private === true;
    const root = path.relative(repoRoot, pkgDir).replace(/\\/g, "/") || ".";

    // Collect internal dependencies — packages that are also in this workspace
    const dependencies: string[] = [];
    const allDeps = {
        ...(parsed.dependencies as Record<string, string> ?? {}),
        ...(parsed.devDependencies as Record<string, string> ?? {}),
    };

    for (const depName of Object.keys(allDeps)) {
        if (allPkgNames.has(depName)) {
            dependencies.push(depName);
        }
    }

    return { name, root, version, isPrivate, dependencies };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Detect the workspace structure of a repository.
 * Returns a WorkspaceInfo describing the monorepo tool and all discovered packages.
 *
 * Resolution priority:
 *   1. pnpm-workspace.yaml → pnpm
 *   2. turbo.json → turbo
 *   3. nx.json → nx
 *   4. lerna.json → lerna
 *   5. package.json workspaces → npm/yarn
 *   6. If none found → { isMonorepo: false, tool: "none", packages: [] }
 */
export function detectWorkspaces(repoRoot: string): WorkspaceInfo {
    const workspaceDirs: string[] = [];
    let tool: WorkspaceInfo["tool"] = "none";

    // ── 1. pnpm-workspace.yaml ────────────────────────────────────────────────
    const pnpmYaml = safeReadText(path.join(repoRoot, "pnpm-workspace.yaml"));
    if (pnpmYaml) {
        tool = "pnpm";
        // Parse YAML-like "packages:" entries (simple line-based, no full YAML parser)
        const lines = pnpmYaml.split("\n");
        let inPackages = false;
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === "packages:") { inPackages = true; continue; }
            if (inPackages && trimmed.startsWith("- ")) {
                const pattern = trimmed.slice(2).replace(/['"]/g, "").trim();
                workspaceDirs.push(...expandWorkspaceGlob(repoRoot, pattern));
            } else if (inPackages && !trimmed.startsWith("-") && !trimmed.startsWith("#") && trimmed.length > 0) {
                inPackages = false; // Exited the packages block
            }
        }
    }

    // ── 2. turbo.json ─────────────────────────────────────────────────────────
    if (workspaceDirs.length === 0) {
        const turboJson = safeReadJson(path.join(repoRoot, "turbo.json"));
        if (turboJson) {
            tool = "turbo";
            // Turbo uses the package.json workspaces field — read it below
        }
    }

    // ── 3. nx.json ────────────────────────────────────────────────────────────
    if (workspaceDirs.length === 0) {
        const nxJson = safeReadJson(path.join(repoRoot, "nx.json"));
        if (nxJson) {
            tool = "nx";
            // Nx defaults to packages in 'packages/', 'apps/', 'libs/'
            for (const dir of ["packages", "apps", "libs"]) {
                workspaceDirs.push(...expandWorkspaceGlob(repoRoot, `${dir}/*`));
            }
        }
    }

    // ── 4. lerna.json ─────────────────────────────────────────────────────────
    if (workspaceDirs.length === 0) {
        const lernaJson = safeReadJson(path.join(repoRoot, "lerna.json"));
        if (lernaJson) {
            tool = "lerna";
            const patterns = (lernaJson.packages as string[]) ?? ["packages/*"];
            for (const pattern of patterns) {
                workspaceDirs.push(...expandWorkspaceGlob(repoRoot, pattern));
            }
        }
    }

    // ── 5. package.json workspaces (npm/yarn) ─────────────────────────────────
    if (workspaceDirs.length === 0) {
        const rootPkg = safeReadJson(path.join(repoRoot, "package.json"));
        if (rootPkg) {
            const ws = rootPkg.workspaces;
            const patterns = Array.isArray(ws)
                ? ws as string[]
                : (ws as { packages?: string[] })?.packages ?? [];

            if (patterns.length > 0) {
                tool = tool === "none"
                    ? (fs.existsSync(path.join(repoRoot, "yarn.lock")) ? "yarn" : "npm")
                    : tool; // Keep turbo/nx if already detected
                for (const pattern of patterns) {
                    workspaceDirs.push(...expandWorkspaceGlob(repoRoot, pattern));
                }
            }
        }
    }

    // ── 6. Fallback: scan common monorepo directories ─────────────────────────
    if (workspaceDirs.length === 0) {
        for (const dir of ["packages", "apps", "libs", "modules", "services"]) {
            const full = path.join(repoRoot, dir);
            if (fs.existsSync(full)) {
                workspaceDirs.push(...expandWorkspaceGlob(repoRoot, `${dir}/*`));
            }
        }
    }

    // Deduplicate workspace directories
    const uniqueDirs = [...new Set(workspaceDirs)];

    // ── First pass: collect all package names ─────────────────────────────────
    const allPkgNames = new Set<string>();
    for (const dir of uniqueDirs) {
        const pkg = safeReadJson(path.join(dir, "package.json"));
        if (pkg && typeof pkg.name === "string") {
            allPkgNames.add(pkg.name);
        }
    }

    // Also include root package
    const rootPkg = safeReadJson(path.join(repoRoot, "package.json"));
    if (rootPkg && typeof rootPkg.name === "string") {
        allPkgNames.add(rootPkg.name);
    }

    // ── Second pass: build package info with dependency resolution ─────────────
    const packages: WorkspacePackageInfo[] = [];
    for (const dir of uniqueDirs) {
        const info = readPackageInfo(dir, repoRoot, allPkgNames);
        if (info) packages.push(info);
    }

    const isMonorepo = packages.length > 1;

    if (packages.length > 0) {
        console.log(
            `[workspaceResolver] detected ${packages.length} workspace packages ` +
            `(tool: ${tool}, monorepo: ${isMonorepo})`
        );
        for (const pkg of packages.slice(0, 10)) {
            console.log(
                `  ${pkg.name} @ ${pkg.root} ` +
                `(deps: ${pkg.dependencies.join(", ") || "none"})`
            );
        }
    }

    return { isMonorepo, tool, packages };
}

/**
 * Given a file's relative path and the workspace packages list,
 * determine which package this file belongs to.
 * Returns the package info or undefined if the file is at the root level.
 */
export function resolveFilePackage(
    filePath: string,
    packages: WorkspacePackageInfo[]
): WorkspacePackageInfo | undefined {
    // Normalize to forward slashes
    const normalized = filePath.replace(/\\/g, "/");

    // Find the most specific (longest root) package that contains this file
    let bestMatch: WorkspacePackageInfo | undefined;
    let bestLength = 0;

    for (const pkg of packages) {
        const root = pkg.root.replace(/\\/g, "/");
        if (root === ".") continue; // skip root package
        if (normalized.startsWith(root + "/") && root.length > bestLength) {
            bestMatch = pkg;
            bestLength = root.length;
        }
    }

    return bestMatch;
}
