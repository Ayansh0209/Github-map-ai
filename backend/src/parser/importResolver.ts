// src/parser/adapters/typescript/importResolver.ts
// Resolves raw import specifiers to real file paths in the repo
// Handles: relative paths, tsconfig aliases, node_modules

import fs from "fs";
import path from "path";

export type ResolvedImport =
    | { kind: "internal"; resolvedPath: string }   // path relative to repo root
    | { kind: "external"; packageName: string };   // node_modules

// ── tsconfig alias loader ───────────────────────────────────────────────────

interface TsConfigPaths {
    [alias: string]: string[];
}

function loadTsConfigPaths(repoRoot: string): TsConfigPaths {
    try {
        const tsConfigPath = path.join(repoRoot, "tsconfig.json");
        if (!fs.existsSync(tsConfigPath)) return {};

        const raw = fs.readFileSync(tsConfigPath, "utf-8");

        // strip JSON comments before parsing (tsconfig allows comments)
        const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
        const parsed = JSON.parse(stripped);

        return parsed?.compilerOptions?.paths ?? {};
    } catch {
        // tsconfig unreadable or malformed — continue without aliases
        return {};
    }
}

// ── Extension resolution ────────────────────────────────────────────────────

const EXTENSIONS_TO_TRY = [
    "",           // exact match first
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    "/index.ts",
    "/index.tsx",
    "/index.js",
    "/index.jsx",
];

function tryResolveOnDisk(candidate: string): string | null {
    for (const ext of EXTENSIONS_TO_TRY) {
        const fullPath = candidate + ext;
        if (fs.existsSync(fullPath)) return fullPath;
    }
    return null;
}

// ── Main resolver ───────────────────────────────────────────────────────────

export class ImportResolver {
    private tsConfigPaths: TsConfigPaths;
    private repoRoot: string;

    constructor(repoRoot: string) {
        this.repoRoot = repoRoot;
        this.tsConfigPaths = loadTsConfigPaths(repoRoot);

        const aliasCount = Object.keys(this.tsConfigPaths).length;
        if (aliasCount > 0) {
            console.log(
                `[importResolver] loaded ${aliasCount} tsconfig aliases:`,
                Object.keys(this.tsConfigPaths).join(", ")
            );
        } else {
            console.log(
                `[importResolver] no tsconfig aliases found in ${repoRoot}`
            );
        }
    }
    resolve(specifier: string, fromFilePath: string): ResolvedImport {
        // Case 1: relative path — starts with . or ..
        if (specifier.startsWith(".") || specifier.startsWith("/")) {
            return this.resolveRelative(specifier, fromFilePath);
        }

        // Case 2: tsconfig alias — check before node_modules
        const aliasResolved = this.resolveAlias(specifier, fromFilePath);
        if (aliasResolved) return aliasResolved;

        // Case 3: node_modules — external dependency
        const packageName = specifier.split("/")[0].startsWith("@")
            ? specifier.split("/").slice(0, 2).join("/")   // @scope/package
            : specifier.split("/")[0];                      // package

        return { kind: "external", packageName };
    }

    private resolveRelative(specifier: string, fromFilePath: string): ResolvedImport {
        // fromFilePath is absolute path on disk
        const fromDir = path.dirname(fromFilePath);
        const candidate = path.resolve(fromDir, specifier);
        const resolved = tryResolveOnDisk(candidate);

        if (!resolved) {
            // file doesn't exist on disk — could be generated or deleted
            // treat as external to avoid phantom edges
            return { kind: "external", packageName: specifier };
        }

        // convert absolute disk path → repo-relative path (used as node ID)
        const relativePath = path
            .relative(this.repoRoot, resolved)
            .replace(/\\/g, "/"); // normalise Windows separators

        return { kind: "internal", resolvedPath: relativePath };
    }

    private resolveAlias(
        specifier: string,
        fromFilePath: string
    ): ResolvedImport | null {
        for (const [alias, targets] of Object.entries(this.tsConfigPaths)) {
            // tsconfig paths can have wildcards: "@/*" → ["./src/*"]
            const aliasPrefix = alias.endsWith("/*")
                ? alias.slice(0, -2)   // "@/" from "@/*"
                : alias;

            if (!specifier.startsWith(aliasPrefix)) continue;

            const remainder = specifier.slice(aliasPrefix.length);

            for (const target of targets) {
                const targetBase = target.endsWith("/*")
                    ? target.slice(0, -2)
                    : target;

                const candidate = path.resolve(
                    this.repoRoot,
                    targetBase + remainder
                );

                const resolved = tryResolveOnDisk(candidate);
                if (!resolved) continue;

                const relativePath = path
                    .relative(this.repoRoot, resolved)
                    .replace(/\\/g, "/");

                return { kind: "internal", resolvedPath: relativePath };
            }
        }
        // log first-time alias miss to help debug monorepos
        if (Object.keys(this.tsConfigPaths).length > 0) {
            console.log(`[importResolver] alias miss: "${specifier}" — no alias matched`);
        }
        return null; // no alias matched
    }
}