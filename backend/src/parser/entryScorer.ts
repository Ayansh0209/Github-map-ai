// src/parser/entryScorer.ts
// ─────────────────────────────────────────────────────────────────────────────
// Deterministic entry point scoring for repo files.
//
// Replaces naive filename checks (index.ts, server.js) with a weighted signal
// system that correctly identifies TRUE application entry points vs. examples,
// tests, scaffolding, or library barrel files.
//
// Score interpretation:
//   >= ENTRY_THRESHOLD  → isEntryPoint = true
//   < ENTRY_THRESHOLD   → isEntryPoint = false (but score still stored for debug)
//
// Design goals:
//   - Purely deterministic — no AI, no heuristics beyond simple string/AST checks
//   - All signals are auditable via entryReasons[] on the FileNode
//   - Penalties ensure example/demo/scaffold folders never dominate
// ─────────────────────────────────────────────────────────────────────────────

import fs   from "fs";
import path from "path";
import { FileNode } from "../models/schema";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Files that score at or above this threshold are marked isEntryPoint = true */
export const ENTRY_THRESHOLD = 15;

// ── package.json field loading ────────────────────────────────────────────────

interface PackageEntryFields {
    main:    string | null;
    module:  string | null;
    bin:     string[];        // absolute normalized paths derived from bin field
    exports: string[];        // top-level string targets from "exports"
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return null;
    }
}

/**
 * Normalize a package.json path field (relative to package dir) to a
 * canonical forward-slash path relative to repo root.
 */
function normalizePkgPath(raw: string, pkgDir: string, repoRoot: string): string {
    const abs = path.resolve(pkgDir, raw);
    // Strip extensions for matching — some package.json use ".js" but source is ".ts"
    const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");
    return rel.replace(/\.(js|mjs|cjs|jsx|ts|tsx)$/, "");
}

/**
 * Extract canonical entry paths from a package.json.
 * Handles main, module, bin (string or object), and simple exports.
 */
function loadPackageEntryFields(pkgJsonPath: string, repoRoot: string): PackageEntryFields {
    const parsed = safeReadJson(pkgJsonPath);
    if (!parsed) return { main: null, module: null, bin: [], exports: [] };

    const pkgDir = path.dirname(pkgJsonPath);

    const main = typeof parsed.main === "string"
        ? normalizePkgPath(parsed.main, pkgDir, repoRoot)
        : null;

    const module_ = typeof parsed.module === "string"
        ? normalizePkgPath(parsed.module, pkgDir, repoRoot)
        : null;

    // bin: either a string or { name: path } object
    const binPaths: string[] = [];
    if (typeof parsed.bin === "string") {
        binPaths.push(normalizePkgPath(parsed.bin, pkgDir, repoRoot));
    } else if (parsed.bin && typeof parsed.bin === "object") {
        for (const v of Object.values(parsed.bin as Record<string, string>)) {
            if (typeof v === "string") binPaths.push(normalizePkgPath(v, pkgDir, repoRoot));
        }
    }

    // exports: only handle simple string value at "." or root string
    const exportPaths: string[] = [];
    const exportsField = parsed.exports;
    if (typeof exportsField === "string") {
        exportPaths.push(normalizePkgPath(exportsField, pkgDir, repoRoot));
    } else if (exportsField && typeof exportsField === "object") {
        const dot = (exportsField as Record<string, unknown>)["."];
        if (typeof dot === "string") exportPaths.push(normalizePkgPath(dot, pkgDir, repoRoot));
    }

    return { main, module: module_, bin: binPaths, exports: exportPaths };
}

// ── Path penalty helpers ───────────────────────────────────────────────────────

/**
 * Folder segments that strongly indicate this file is NOT a primary entry point.
 * Any file inside these directories gets a heavy penalty.
 */
const PENALTY_FOLDER_SEGMENTS = new Set([
    "example", "examples",
    "demo", "demos",
    "test", "tests", "__tests__",
    "spec", "specs",
    "fixture", "fixtures",
    "seed", "seeds",
    "migration", "migrations",
    "scaffold", "scaffolds",
    "scripts",          // build/deploy scripts — not runtime entry
    "tools",
    "bench", "benchmarks",
    "docs", "documentation",
    "storybook", ".storybook",
    "e2e",
    "cypress",
    "mocks", "__mocks__",
]);

/**
 * Entry-point filename stems (without extension).
 * Files with these names get a moderate bonus.
 */
const ENTRY_STEMS = new Set([
    "index", "main", "server", "app",
    "entry", "start", "init",
    "bootstrap", "run",
    "cli", "bin",
]);

/**
 * Next.js app router semantic files.
 * These are inherently entry points for specific routes/layouts.
 */
const NEXTJS_SEMANTIC_STEMS = new Set([
    "page", "layout", "route", "loading", "error", "middleware"
]);

// ── Score input ───────────────────────────────────────────────────────────────

export interface ScoringInput {
    file:              FileNode;
    inDegree:          number;    // how many files import this file
    outDegree:         number;    // how many files this file imports
    hasStartupSignals: boolean;   // from fileLevel AST scan (app.listen etc.)
    hasRouteHandlers:  boolean;   // from fileLevel AST scan (app.get/post etc.)
    pkgFields:         PackageEntryFields;
}

export interface ScoringResult {
    score:   number;
    reasons: string[];
}

// ── Scorer ────────────────────────────────────────────────────────────────────

function scoreFile(input: ScoringInput): ScoringResult {
    const { file, inDegree, outDegree, hasStartupSignals, hasRouteHandlers, pkgFields } = input;
    const filePath = file.id; // forward-slash relative path

    let score  = 0;
    const reasons: string[] = [];

    function add(pts: number, reason: string) {
        score += pts;
        reasons.push(`${reason} ${pts > 0 ? "+" : ""}${pts}`);
    }

    // ── Penalties (applied first — disqualifiers) ─────────────────────────────

    // Check every path segment for known penalty folders
    const segments = filePath.split("/");
    const penaltySegment = segments.find((s) => PENALTY_FOLDER_SEGMENTS.has(s.toLowerCase()));
    if (penaltySegment) {
        add(-50, `in "${penaltySegment}/" folder (example/test/script penalty)`);
    }

    // Config files are never entry points regardless of name
    if (file.kind === "config") {
        add(-30, "config file kind");
    }

    // Declaration files are never entry points
    if (file.kind === "declaration") {
        add(-100, "declaration file (.d.ts)");
    }

    // Test files are never entry points
    if (file.kind === "test") {
        add(-50, "test file kind");
    }

    // ── Bonus: package.json explicit entry references ─────────────────────────

    // Strip extension for comparison (source might be .ts but pkg references .js)
    const filePathNoExt = filePath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");

    if (pkgFields.main && filePathNoExt === pkgFields.main) {
        add(20, `package.json "main"`);
    }
    if (pkgFields.module && filePathNoExt === pkgFields.module) {
        add(20, `package.json "module"`);
    }
    if (pkgFields.bin.includes(filePathNoExt)) {
        add(20, `package.json "bin"`);
    }
    if (pkgFields.exports.includes(filePathNoExt)) {
        add(15, `package.json "exports" root`);
    }

    // ── Bonus: filename stem ──────────────────────────────────────────────────

    const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
    if (ENTRY_STEMS.has(stem)) {
        add(15, `entry filename stem "${stem}"`);
    } else if (NEXTJS_SEMANTIC_STEMS.has(stem)) {
        add(15, `Next.js semantic file "${stem}"`);
    }

    // ── Bonus: root depth ─────────────────────────────────────────────────────
    // Files at repo root (depth 1) get the full bonus.
    // Files one level deep (src/index.ts) get a smaller bonus.
    // Deeper files get nothing.
    const depth = filePath.split("/").length; // 1 = root file, 2 = one folder deep
    if (depth === 1) {
        add(10, "root-level file");
    } else if (depth === 2) {
        add(5, "one directory deep");
    }

    // ── Bonus: AST startup signals ────────────────────────────────────────────

    if (hasStartupSignals) {
        add(10, "server startup call (app.listen / createServer)");
    }

    if (hasRouteHandlers) {
        add(8, "route handler registration (app.get/post/use)");
    }

    // ── Bonus: graph topology ─────────────────────────────────────────────────
    // A true entry point is typically imported by NOTHING (inDegree = 0)
    // but imports several things (outDegree > 0). This avoids promoting
    // leaf utility files.

    if (inDegree === 0 && outDegree > 0) {
        add(8, `graph root (inDegree=0, outDegree=${outDegree})`);
    }

    // High in-degree files are likely shared utilities, not entry points
    if (inDegree >= 10) {
        add(-5, `high import count (inDegree=${inDegree}, likely utility)`);
    }

    return { score, reasons };
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface EntryScorerOptions {
    /** Absolute path to the repo root (for reading package.json) */
    repoRoot: string;
    /** Startup signal map: fileId → true/false (from fileLevel extraction) */
    startupSignals: Map<string, boolean>;
    /** Route handler map: fileId → true/false (from fileLevel extraction) */
    routeHandlers: Map<string, boolean>;
}

/**
 * Score all files and update their isEntryPoint, entryScore, and entryReasons fields.
 * Mutates fileNodes in-place so the rest of the builder pipeline is unaffected.
 *
 * Call this AFTER all fileNodes and importEdges are assembled (so degree counts
 * are accurate).
 */
export function applyEntryScoring(
    fileNodes:   FileNode[],
    importEdges: Array<{ source: string; target: string }>,
    options:     EntryScorerOptions
): void {
    const { repoRoot, startupSignals, routeHandlers } = options;

    // ── Load package.json ─────────────────────────────────────────────────────
    const pkgFields = loadPackageEntryFields(
        path.join(repoRoot, "package.json"),
        repoRoot
    );

    // ── Build degree maps from import edges ───────────────────────────────────
    const inDegree  = new Map<string, number>();
    const outDegree = new Map<string, number>();

    for (const edge of importEdges) {
        outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
        inDegree.set(edge.target,  (inDegree.get(edge.target)  ?? 0) + 1);
    }

    // ── Score each file ───────────────────────────────────────────────────────
    let entryCount = 0;

    for (const file of fileNodes) {
        const result = scoreFile({
            file,
            inDegree:          inDegree.get(file.id)  ?? 0,
            outDegree:         outDegree.get(file.id) ?? 0,
            hasStartupSignals: startupSignals.get(file.id) ?? false,
            hasRouteHandlers:  routeHandlers.get(file.id)  ?? false,
            pkgFields,
        });

        file.entryScore   = result.score;
        file.entryReasons = result.reasons;
        file.isEntryPoint = result.score >= ENTRY_THRESHOLD;

        if (file.isEntryPoint) entryCount++;
    }

    console.log(
        `[entryScorer] scored ${fileNodes.length} files — ` +
        `${entryCount} entry points (threshold=${ENTRY_THRESHOLD})`
    );
}
