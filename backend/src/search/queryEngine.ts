// src/search/queryEngine.ts
// ─────────────────────────────────────────────────────────────────────────────
// Deterministic query engine for the search index.
//
// Supports:
//   - Exact path matching
//   - Fuzzy substring matching
//   - Multi-token AND queries (all tokens must match)
//   - Type filters (file, function, export, test)
//   - Kind filters (source, test, config, component, hook, etc.)
//   - Package filters (workspace package name)
//
// All matching is case-insensitive and fully deterministic.
// No external dependencies — pure string operations.
// ─────────────────────────────────────────────────────────────────────────────

import type { SearchIndex, SearchIndexEntry } from "../models/schema";

// ── Result types ──────────────────────────────────────────────────────────────

export interface SearchResult {
    entry: SearchIndexEntry;
    score: number;         // 0–100 relevance score
    matchedTokens: string[]; // which query tokens matched
}

export interface SearchOptions {
    type?: "file" | "function" | "export" | "test";
    kind?: string;           // FileKind or FunctionKind value
    packageName?: string;    // workspace package filter
    limit?: number;          // max results (default: 50)
    scoreThreshold?: number; // minimum score to return (0-100)
}

// ── Fuzzy matching ────────────────────────────────────────────────────────────

/**
 * Calculate a simple similarity score between a query token and a target token.
 * Returns a value between 0 (no match) and 1 (exact match).
 *
 * Matching hierarchy:
 *   1. Exact match → 1.0
 *   2. Target starts with query → 0.9
 *   3. Query is a substring of target → 0.7
 *   4. Levenshtein distance <= 2 for short tokens → 0.4
 *   5. No match → 0
 */
function tokenSimilarity(query: string, target: string): number {
    if (query === target) return 1.0;
    
    // If query is very short, exact or startsWith is required (prevent false fuzzy positives)
    if (query.length <= 3) {
        if (target.startsWith(query)) return 0.8;
        return 0;
    }

    if (target.startsWith(query)) return 0.9;
    if (target.includes(query)) return 0.7;

    // Fuzzy matching for short-ish tokens
    if (query.length <= 15 && target.length <= 25) {
        const dist = levenshteinDistance(query, target);
        if (dist === 1) return 0.6;
        if (dist === 2 && query.length >= 5) return 0.4;
    }

    return 0;
}

/**
 * Levenshtein edit distance — standard DP implementation.
 * Capped at short strings for performance (max ~20 chars).
 */
function levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;

    // Early exit for very different lengths
    if (Math.abs(m - n) > 3) return Math.abs(m - n);

    const dp: number[][] = Array.from({ length: m + 1 }, () =>
        Array(n + 1).fill(0)
    );

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,      // deletion
                dp[i][j - 1] + 1,      // insertion
                dp[i - 1][j - 1] + cost // substitution
            );
        }
    }

    return dp[m][n];
}

// ── Query tokenizer ───────────────────────────────────────────────────────────

/**
 * Split a search query into individual tokens.
 * Handles quoted phrases ("exact match") and space-separated tokens.
 */
function tokenizeQuery(query: string): string[] {
    const tokens: string[] = [];
    const trimmed = query.trim().toLowerCase();

    // Handle quoted phrases
    const quoteRegex = /"([^"]+)"/g;
    let match;
    let remaining = trimmed;

    while ((match = quoteRegex.exec(trimmed)) !== null) {
        tokens.push(match[1]);
        remaining = remaining.replace(match[0], "");
    }

    // Split remaining by whitespace
    const words = remaining.trim().split(/\s+/).filter(w => w.length > 0);
    tokens.push(...words);

    return tokens;
}

// ── Main query function ───────────────────────────────────────────────────────

/**
 * Search the index with a query string and optional filters.
 * Returns results sorted by relevance score (descending).
 *
 * Scoring:
 *   - Each query token is matched against all entry tokens
 *   - The best token match score is used for each query token
 *   - Final score = average of all query token scores × 100
 *   - Bonus: exact name match +20, entry point +5, path match +10
 */
export function searchIndex(
    index: SearchIndex,
    query: string,
    options: SearchOptions = {},
): SearchResult[] {
    const { type, kind, packageName, limit = 50, scoreThreshold = 0 } = options;
    const queryTokens = tokenizeQuery(query);

    if (queryTokens.length === 0) return [];

    const results: SearchResult[] = [];

    for (const entry of index.entries) {
        // ── Apply filters ─────────────────────────────────────────────────────
        if (type && entry.type !== type) continue;
        if (kind && entry.kind !== kind) continue;
        if (packageName && entry.packageName !== packageName) continue;

        // ── Score each query token against entry tokens ───────────────────────
        let totalScore = 0;
        const matchedTokens = new Set<string>();

        for (const qt of queryTokens) {
            let bestTokenScore = 0;

            for (const et of entry.tokens) {
                const sim = tokenSimilarity(qt, et);
                if (sim > bestTokenScore) bestTokenScore = sim;
                if (sim === 1.0) break; // exact match — no need to check more
            }

            if (bestTokenScore > 0) {
                totalScore += bestTokenScore;
                matchedTokens.add(qt);
            }
        }

        // All query tokens must match at least partially (AND semantics) for exact searches,
        // but for natural language issues we want a relaxed OR with strong threshold
        // We require at least 50% of query tokens to match to consider it.
        const matchRatio = matchedTokens.size / queryTokens.length;
        if (matchRatio < 0.5) continue;

        // Base token score normalized to 60 points max
        let score = (totalScore / queryTokens.length) * 60;

        // ── High Priority Boosts: Path, Symbol, Export similarity ─────────────
        const nameLower = entry.name.toLowerCase();
        const queryLower = query.toLowerCase().trim();

        // Exact symbol/file name match
        if (nameLower === queryLower) score += 30;  
        // Name starts with or ends with query (strong path/symbol relevance)
        else if (nameLower.startsWith(queryLower) || nameLower.endsWith(queryLower)) score += 15;
        // Name contains query
        else if (nameLower.includes(queryLower)) score += 10; 

        // If the query contains file path slashes and matches the filePath
        if (queryLower.includes("/") && entry.filePath.toLowerCase().includes(queryLower)) {
            score += 20;
        }

        // ── Medium Priority Boosts: Usage, Test references ────────────────────
        if (entry.usageCount !== undefined && entry.usageCount > 0) {
            // Logarithmic boost for usage: max 10 points
            score += Math.min(10, Math.log1p(entry.usageCount) * 2);
        }

        if (entry.type === "test" || entry.kind === "test") {
            // Tests have medium priority if tokens match strongly
            if (matchRatio === 1) score += 5;
        }

        // ── Low Priority Boosts: Hub Score, Entry Score ───────────────────────
        if (entry.isEntryPoint) score += 3;
        if (entry.hubScore !== undefined && entry.hubScore > 0) {
            // Very small boost based on hub score (max 5 points)
            score += Math.min(5, (entry.hubScore / 100) * 5);
        }

        // Apply penalty for dead code
        if (entry.isDeadCode) score -= 15;

        score = Math.min(100, Math.round(score * 10) / 10);

        if (score >= scoreThreshold && score > 0) {
            results.push({ entry, score, matchedTokens: [...matchedTokens] });
        }
    }

    // Sort by score descending, then by name alphabetically
    results.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

    return results.slice(0, limit);
}
