// src/parser/aliasResolver.ts
// ─────────────────────────────────────────────────────────────────────────────
// Deterministic alias resolution for TypeScript/JavaScript repos.
//
// Resolution priority (config-first):
//   1. tsconfig.json / jsconfig.json  → compilerOptions.paths + baseUrl
//   2. package.json "imports" field    → Node.js subpath imports (#alias)
//   3. package.json "exports" field    → self-referencing the package
//   4. Workspace / monorepo packages   → sibling packages in workspace
//   5. Framework fallbacks             → only if NO config was found
//
// All resolved paths are cached after first lookup. The cache is keyed by
// (specifier + fromFile) so re-running the same import costs O(1).
// ─────────────────────────────────────────────────────────────────────────────

import fs   from "fs";
import path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Alias entry: a prefix → list of replacement base paths */
interface AliasEntry {
    prefix:    string;   // e.g. "@/" or "#utils/"
    targets:   string[]; // absolute base paths to try
    isWildcard: boolean; // true when alias ends in /* or /* removed suffix
}

/** A resolved import: either an internal file path or an external package */
export type AliasResult =
    | { kind: "internal"; resolvedPath: string }  // relative to repo root
    | { kind: "external"; packageName: string }
    | { kind: "unresolved" };                      // alias matched but file missing

// ── Node.js built-in modules ──────────────────────────────────────────────────
// Complete list as of Node 20. "node:" prefix is also accepted.
const NODE_BUILTINS = new Set([
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
    "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
    "events", "fs", "http", "http2", "https", "inspector", "module", "net",
    "os", "path", "perf_hooks", "process", "punycode", "querystring",
    "readline", "repl", "stream", "string_decoder", "sys", "timers",
    "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi",
    "worker_threads", "zlib",
]);

/** True if the specifier is a Node.js built-in (with or without the "node:" prefix) */
export function isNodeBuiltin(specifier: string): boolean {
    const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
    return NODE_BUILTINS.has(bare);
}

// ── File system helpers ───────────────────────────────────────────────────────

const EXTENSIONS_TO_TRY = [
    "",             // exact match first
    ".ts", ".tsx",
    ".js", ".jsx",
    ".mjs", ".cjs",
    "/index.ts", "/index.tsx",
    "/index.js",  "/index.jsx",
];

function tryResolveOnDisk(candidate: string): string | null {
    for (const ext of EXTENSIONS_TO_TRY) {
        if (fs.existsSync(candidate + ext)) return candidate + ext;
    }
    return null;
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        // Strip JS-style comments (tsconfig allows them, some tooling too)
        const stripped = raw
            .replace(/\/\/.*$/gm, "")
            .replace(/\/\*[\s\S]*?\*\//g, "");
        return JSON.parse(stripped) as Record<string, unknown>;
    } catch {
        return null;
    }
}

// ── AliasResolver class ───────────────────────────────────────────────────────

export class AliasResolver {
    private readonly repoRoot:       string;
    private readonly aliases:        AliasEntry[];
    private readonly selfPackage:    string | null; // package.json "name" field
    private readonly workspacePkgs:  Map<string, string>; // pkgName → absolute src dir
    private readonly hasConfigAlias: boolean; // true when tsconfig/jsconfig provided aliases

    // Resolution cache: "specifier|fromAbsFile" → AliasResult
    private readonly cache = new Map<string, AliasResult>();

    constructor(repoRoot: string) {
        this.repoRoot = repoRoot;

        const { entries, hasConfig } = this.loadAllAliases();
        this.aliases        = entries;
        this.hasConfigAlias = hasConfig;

        const pkgJson       = safeReadJson(path.join(repoRoot, "package.json"));
        this.selfPackage    = typeof pkgJson?.name === "string" ? pkgJson.name : null;
        this.workspacePkgs  = this.detectWorkspacePackages(pkgJson);

        this.logSummary();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Try to resolve a specifier as an alias/internal import.
     * Returns null if the specifier is clearly NOT an alias (e.g., relative "./foo").
     * Never throws.
     */
    resolve(specifier: string, fromAbsFile: string): AliasResult | null {
        // Relative imports are never aliases — let ImportResolver handle them
        if (specifier.startsWith(".") || specifier.startsWith("/")) return null;

        // Node builtins are always external — no alias resolution needed
        if (isNodeBuiltin(specifier)) {
            return { kind: "external", packageName: specifier };
        }

        const cacheKey = `${specifier}|${fromAbsFile}`;
        if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

        const result = this.resolveUncached(specifier, fromAbsFile);
        this.cache.set(cacheKey, result);
        return result;
    }

    // ── Core resolution logic ─────────────────────────────────────────────────

    private resolveUncached(specifier: string, fromAbsFile: string): AliasResult {
        // 1. Self-referencing by package name (e.g., "myapp/utils" in myapp)
        if (this.selfPackage && specifier === this.selfPackage) {
            const candidate = path.join(this.repoRoot, "src");
            const resolved  = tryResolveOnDisk(candidate);
            if (resolved) return this.makeInternal(resolved);
        }

        if (this.selfPackage && specifier.startsWith(this.selfPackage + "/")) {
            const remainder = specifier.slice(this.selfPackage.length + 1);
            const candidate = path.join(this.repoRoot, remainder);
            const resolved  = tryResolveOnDisk(candidate);
            if (resolved) return this.makeInternal(resolved);
        }

        // 2. Workspace packages (monorepo siblings)
        const pkgName = specifier.includes("/") && specifier.startsWith("@")
            ? specifier.split("/").slice(0, 2).join("/")
            : specifier.split("/")[0];
        const workspaceSrcDir = this.workspacePkgs.get(pkgName);
        if (workspaceSrcDir) {
            const remainder = specifier.slice(pkgName.length + 1) || "";
            const candidate = remainder
                ? path.join(workspaceSrcDir, remainder)
                : workspaceSrcDir;
            const resolved  = tryResolveOnDisk(candidate);
            if (resolved) return this.makeInternal(resolved);
        }

        // 3. Alias table (tsconfig paths, jsconfig paths, package.json imports,
        //    framework fallbacks). Entries are already sorted longest-prefix-first.
        for (const entry of this.aliases) {
            if (!specifier.startsWith(entry.prefix)) continue;

            const remainder = entry.isWildcard
                ? specifier.slice(entry.prefix.length)
                : "";

            for (const targetBase of entry.targets) {
                const candidate = remainder
                    ? path.join(targetBase, remainder)
                    : targetBase;
                const resolved  = tryResolveOnDisk(candidate);
                if (resolved) return this.makeInternal(resolved);
            }

            // Alias matched but no file found on disk
            return { kind: "unresolved" };
        }

        return { kind: "external", packageName: pkgName };
    }

    private makeInternal(absPath: string): AliasResult {
        const relativePath = path.relative(this.repoRoot, absPath).replace(/\\/g, "/");
        return { kind: "internal", resolvedPath: relativePath };
    }

    // ── Alias table building ─────────────────────────────────────────────────

    private loadAllAliases(): { entries: AliasEntry[]; hasConfig: boolean } {
        const entries: AliasEntry[] = [];
        let hasConfig = false;

        // ── 1. tsconfig.json (highest priority) ──────────────────────────────
        const tsConfigResult = this.loadTsOrJsConfig("tsconfig.json");
        if (tsConfigResult.length > 0) {
            entries.push(...tsConfigResult);
            hasConfig = true;
        }

        // ── 2. jsconfig.json ─────────────────────────────────────────────────
        const jsConfigResult = this.loadTsOrJsConfig("jsconfig.json");
        if (jsConfigResult.length > 0) {
            entries.push(...jsConfigResult);
            hasConfig = true;
        }

        // ── 3. package.json "imports" (Node.js subpath imports #foo) ─────────
        const importEntries = this.loadPackageImports();
        if (importEntries.length > 0) {
            entries.push(...importEntries);
            hasConfig = true;
        }

        // ── 4. Framework fallbacks — only when NO config alias was found ──────
        // These cover common setups like CRA, Next.js without tsconfig paths,
        // or Vite projects that forgot to add resolve.alias to tsconfig.
        if (!hasConfig) {
            entries.push(...this.frameworkFallbacks());
        }

        // Sort longest prefix first so more specific aliases win
        entries.sort((a, b) => b.prefix.length - a.prefix.length);

        return { entries, hasConfig };
    }

    private loadTsOrJsConfig(filename: string): AliasEntry[] {
        const configPath = path.join(this.repoRoot, filename);
        const parsed     = safeReadJson(configPath);
        if (!parsed) return [];

        const opts     = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
        const entries: AliasEntry[] = [];

        // baseUrl: resolve bare non-relative imports relative to this directory
        // e.g., "utils/parser" → "<baseUrl>/utils/parser.ts"
        const rawBaseUrl = opts.baseUrl as string | undefined;
        if (rawBaseUrl) {
            const baseUrlAbs = path.resolve(this.repoRoot, rawBaseUrl);
            // A baseUrl alias with an empty prefix catches everything — add at end
            entries.push({
                prefix:    "",
                targets:   [baseUrlAbs],
                isWildcard: true,
            });
        }

        // paths: explicit alias mappings
        const paths = (opts.paths ?? {}) as Record<string, string[]>;
        for (const [alias, rawTargets] of Object.entries(paths)) {
            // Determine prefix and whether wildcard
            const isWildcard = alias.endsWith("/*");
            const prefix     = isWildcard ? alias.slice(0, -2) : alias;

            // Resolve target paths relative to the directory containing tsconfig
            const configDir = path.dirname(configPath);
            const targets   = rawTargets.map((t) => {
                const bare    = t.endsWith("/*") ? t.slice(0, -2) : t;
                return path.resolve(configDir, bare);
            });

            entries.push({ prefix, targets, isWildcard });
        }

        return entries;
    }

    private loadPackageImports(): AliasEntry[] {
        // Node.js "imports" field enables #-prefixed package-internal paths
        // e.g., "#utils" → "./src/utils.js"
        const pkgPath = path.join(this.repoRoot, "package.json");
        const parsed  = safeReadJson(pkgPath);
        if (!parsed) return [];

        const imports = parsed.imports as Record<string, unknown> | undefined;
        if (!imports) return [];

        const entries: AliasEntry[] = [];

        for (const [key, value] of Object.entries(imports)) {
            // Only handle string or simple condition-object targets
            const rawTarget = typeof value === "string"
                ? value
                : (value as Record<string, unknown>)?.default as string | undefined
                    ?? (value as Record<string, unknown>)?.require as string | undefined;

            if (!rawTarget) continue;

            const isWildcard = key.endsWith("/*");
            const prefix     = isWildcard ? key.slice(0, -2) : key;
            const targetAbs  = path.resolve(
                this.repoRoot,
                rawTarget.endsWith("/*") ? rawTarget.slice(0, -2) : rawTarget
            );

            entries.push({ prefix, targets: [targetAbs], isWildcard });
        }

        return entries;
    }

    /** Framework-specific fallback aliases used when no config defines paths */
    private frameworkFallbacks(): AliasEntry[] {
        const src     = path.join(this.repoRoot, "src");
        const hasSrc  = fs.existsSync(src);
        const srcOrRoot = hasSrc ? src : this.repoRoot;

        return [
            // Next.js / CRA / Vite convention: @/ → src/ (or root)
            { prefix: "@/",  targets: [srcOrRoot], isWildcard: true },
            // Webpack / tilde convention: ~/ → src/
            { prefix: "~/",  targets: [srcOrRoot], isWildcard: true },
            // Bare @ alias: @components → src/components
            { prefix: "@",   targets: [srcOrRoot], isWildcard: true },
        ];
    }

    // ── Workspace / monorepo detection ───────────────────────────────────────

    /**
     * Detect sibling workspace packages so that imports like "my-ui" in a
     * monorepo can resolve to the actual source instead of being marked external.
     *
     * Only scans one level of known workspace locations to stay lightweight:
     *   - "workspaces" glob from root package.json (npm/yarn)
     *   - "packages/*", "apps/*", "libs/*" as common monorepo conventions
     */
    private detectWorkspacePackages(
        rootPkgJson: Record<string, unknown> | null
    ): Map<string, string> {
        const result = new Map<string, string>();

        // Candidate workspace directories to scan
        const candidateDirs: string[] = [];

        // From package.json "workspaces" field (npm/yarn)
        const workspaces = rootPkgJson?.workspaces as string[] | { packages: string[] } | undefined;
        const wsDirs = Array.isArray(workspaces)
            ? workspaces
            : workspaces?.packages ?? [];

        for (const ws of wsDirs) {
            // Handle "packages/*" glob — just take the literal directory name
            const dirName = ws.replace(/\/\*/g, "").replace(/\*/g, "");
            candidateDirs.push(path.join(this.repoRoot, dirName));
        }

        // Common monorepo conventions (add if they exist on disk)
        for (const dir of ["packages", "apps", "libs", "modules", "services"]) {
            const abs = path.join(this.repoRoot, dir);
            if (fs.existsSync(abs)) candidateDirs.push(abs);
        }

        // Scan each candidate directory for sub-packages
        for (const dir of candidateDirs) {
            if (!fs.existsSync(dir)) continue;
            let entries: string[];
            try { entries = fs.readdirSync(dir); } catch { continue; }

            for (const entry of entries) {
                const pkgDir     = path.join(dir, entry);
                const pkgJsonPath = path.join(pkgDir, "package.json");
                const pkgJson    = safeReadJson(pkgJsonPath);
                if (!pkgJson || typeof pkgJson.name !== "string") continue;

                // Map package name → its src directory (prefer /src, fall back to root)
                const srcDir = path.join(pkgDir, "src");
                result.set(pkgJson.name, fs.existsSync(srcDir) ? srcDir : pkgDir);
            }
        }

        return result;
    }

    // ── Diagnostics ───────────────────────────────────────────────────────────

    private logSummary(): void {
        const aliasCount  = this.aliases.filter((a) => a.prefix !== "").length;
        const hasBaseUrl  = this.aliases.some((a) => a.prefix === "");
        const wsPkgCount  = this.workspacePkgs.size;

        console.log(
            `[aliasResolver] loaded — ` +
            `aliases: ${aliasCount}, ` +
            `baseUrl: ${hasBaseUrl}, ` +
            `workspace pkgs: ${wsPkgCount}, ` +
            `self: ${this.selfPackage ?? "none"}, ` +
            `framework fallbacks: ${!this.hasConfigAlias}`
        );

        if (aliasCount > 0) {
            const preview = this.aliases
                .filter((a) => a.prefix !== "")
                .slice(0, 8)
                .map((a) => `"${a.prefix}${a.isWildcard ? "*" : ""}"`)
                .join(", ");
            console.log(`[aliasResolver] alias prefixes: ${preview}`);
        }
    }
}
