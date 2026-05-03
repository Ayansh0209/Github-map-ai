// src/parser/repoMetadata.ts
// ─────────────────────────────────────────────────────────────────────────────
// Essential repository metadata extraction.
//
// Scans the repository root for infrastructure and configuration signals:
//   - package.json scripts
//   - CI/CD systems (GitHub Actions, CircleCI, Travis, GitLab CI)
//   - Build tools (Vite, Webpack, tsc, esbuild, etc.)
//   - Docker files (Dockerfile, docker-compose.yml)
//   - Environment files (.env, .env.local, .env.production)
//   - Architecture zones (frontend, backend, services, libs)
//
// All detection is file-existence based — no content parsing beyond
// package.json scripts and basic JSON structure reading.
// ─────────────────────────────────────────────────────────────────────────────

import fs   from "fs";
import path from "path";
import type { RepoMetadata, WorkspacePackageInfo } from "../models/schema";

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeReadJson(filePath: string): Record<string, unknown> | null {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function fileExists(filePath: string): boolean {
    try { return fs.existsSync(filePath); } catch { return false; }
}

// ── CI/CD detection ───────────────────────────────────────────────────────────

const CI_DETECTORS: [string, string][] = [
    [".github/workflows", "github-actions"],
    [".circleci",         "circleci"],
    [".travis.yml",       "travis"],
    [".gitlab-ci.yml",    "gitlab-ci"],
    ["Jenkinsfile",       "jenkins"],
    ["azure-pipelines.yml", "azure-devops"],
    ["bitbucket-pipelines.yml", "bitbucket"],
    [".buildkite",        "buildkite"],
    ["vercel.json",       "vercel"],
    ["netlify.toml",      "netlify"],
    ["railway.json",      "railway"],
    ["render.yaml",       "render"],
    ["fly.toml",          "fly-io"],
];

function detectCISystems(repoRoot: string): string[] {
    const systems: string[] = [];
    for (const [pathSuffix, name] of CI_DETECTORS) {
        if (fileExists(path.join(repoRoot, pathSuffix))) {
            systems.push(name);
        }
    }
    return systems;
}

// ── Build tool detection ──────────────────────────────────────────────────────

const BUILD_TOOL_DETECTORS: [string, string][] = [
    ["vite.config.ts",      "vite"],
    ["vite.config.js",      "vite"],
    ["webpack.config.js",   "webpack"],
    ["webpack.config.ts",   "webpack"],
    ["rollup.config.js",    "rollup"],
    ["rollup.config.ts",    "rollup"],
    ["esbuild.config.js",   "esbuild"],
    ["tsup.config.ts",      "tsup"],
    ["tsdown.config.ts",    "tsdown"],
    ["next.config.js",      "nextjs"],
    ["next.config.ts",      "nextjs"],
    ["next.config.mjs",     "nextjs"],
    ["nuxt.config.ts",      "nuxt"],
    ["nuxt.config.js",      "nuxt"],
    ["remix.config.js",     "remix"],
    ["astro.config.mjs",    "astro"],
    ["svelte.config.js",    "sveltekit"],
    ["turbo.json",          "turborepo"],
    ["nx.json",             "nx"],
    ["lerna.json",          "lerna"],
    ["Makefile",            "make"],
    ["Cargo.toml",          "cargo"],
    ["go.mod",              "go"],
];

function detectBuildTools(repoRoot: string): string[] {
    const tools = new Set<string>();

    // File-based detection
    for (const [filename, toolName] of BUILD_TOOL_DETECTORS) {
        if (fileExists(path.join(repoRoot, filename))) {
            tools.add(toolName);
        }
    }

    // tsconfig.json presence → tsc is likely used
    if (fileExists(path.join(repoRoot, "tsconfig.json"))) {
        tools.add("tsc");
    }

    return [...tools];
}

// ── Docker detection ──────────────────────────────────────────────────────────

const DOCKER_PATTERNS = [
    "Dockerfile",
    "Dockerfile.dev",
    "Dockerfile.prod",
    "docker-compose.yml",
    "docker-compose.yaml",
    "docker-compose.dev.yml",
    "docker-compose.prod.yml",
    ".dockerignore",
];

function detectDockerFiles(repoRoot: string): string[] {
    return DOCKER_PATTERNS.filter(f => fileExists(path.join(repoRoot, f)));
}

// ── Environment file detection ────────────────────────────────────────────────

const ENV_PATTERNS = [
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.staging",
    ".env.test",
    ".env.example",
    ".env.sample",
];

function detectEnvFiles(repoRoot: string): string[] {
    return ENV_PATTERNS.filter(f => fileExists(path.join(repoRoot, f)));
}

// ── Architecture zone detection ───────────────────────────────────────────────

const ZONE_MAPPINGS: [string[], string][] = [
    [["frontend", "client", "web", "app"],          "frontend"],
    [["backend", "server", "api"],                   "backend"],
    [["services", "microservices"],                   "services"],
    [["libs", "lib", "shared", "common", "core"],    "shared-libs"],
    [["packages"],                                    "packages"],
    [["infra", "infrastructure", "deploy", "k8s"],   "infrastructure"],
    [["docs", "documentation"],                       "docs"],
    [["scripts", "tools", "bin"],                     "tooling"],
];

function detectArchitectureZones(repoRoot: string): { zone: string; paths: string[] }[] {
    const zones: { zone: string; paths: string[] }[] = [];

    for (const [dirNames, zoneName] of ZONE_MAPPINGS) {
        const matchingPaths: string[] = [];
        for (const dirName of dirNames) {
            if (fileExists(path.join(repoRoot, dirName))) {
                matchingPaths.push(dirName);
            }
        }
        if (matchingPaths.length > 0) {
            zones.push({ zone: zoneName, paths: matchingPaths });
        }
    }

    return zones;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract essential metadata from the repository root.
 * All detection is lightweight — file existence checks and package.json reading only.
 */
export function extractRepoMetadata(
    repoRoot: string,
    workspacePackages: WorkspacePackageInfo[] = [],
): RepoMetadata {
    // ── Package info ──────────────────────────────────────────────────────────
    const packages = workspacePackages.map(pkg => ({
        name: pkg.name,
        path: pkg.root,
        isPrivate: pkg.isPrivate ?? false,
    }));

    // ── Scripts from root package.json ────────────────────────────────────────
    const rootPkg = safeReadJson(path.join(repoRoot, "package.json"));
    const scripts = (rootPkg?.scripts as Record<string, string>) ?? {};

    // ── Detect infrastructure ─────────────────────────────────────────────────
    const ciSystems  = detectCISystems(repoRoot);
    const buildTools = detectBuildTools(repoRoot);
    const envFiles   = detectEnvFiles(repoRoot);
    const dockerFiles = detectDockerFiles(repoRoot);
    const architectureZones = detectArchitectureZones(repoRoot);

    console.log(
        `[repoMetadata] extracted — ` +
        `packages: ${packages.length}, ` +
        `scripts: ${Object.keys(scripts).length}, ` +
        `ci: [${ciSystems.join(", ")}], ` +
        `build: [${buildTools.join(", ")}], ` +
        `docker: ${dockerFiles.length} files, ` +
        `env: ${envFiles.length} files, ` +
        `zones: ${architectureZones.length}`
    );

    return {
        packages,
        scripts,
        ciSystems,
        buildTools,
        envFiles,
        dockerFiles,
        architectureZones,
    };
}
