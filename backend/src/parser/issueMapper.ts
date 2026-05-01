// src/parser/issueMapper.ts
// ─────────────────────────────────────────────────────────────────────────────
// Deterministic issue mapping foundation.
//
// Translates a natural language query (issue title, error message, keyword list)
// into ranked file and function candidates using the search index.
//
// This is the AI-ready retrieval layer — all matching is deterministic:
//   1. Tokenize the query
//   2. Search the index for matching files, exports, and tests
//   3. Score candidates by match quality + architectural importance
//   4. Return ranked IssueMappingResult
//
// No AI, no heuristics, no external API calls.
// Future AI layer will use this as its context injection foundation.
// ─────────────────────────────────────────────────────────────────────────────

import type {
    SearchIndex,
    IssueMappingResult,
    IssueMappingCandidate,
    FileNode,
} from "../models/schema";
import { searchIndex as runSearch } from "../search/queryEngine";

// ── Stopwords — common words that add no signal ───────────────────────────────

const STOPWORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "must",
    "in", "on", "at", "to", "for", "with", "by", "from", "of", "into",
    "about", "between", "through", "after", "before", "above", "below",
    "and", "or", "but", "not", "no", "nor", "so", "yet",
    "this", "that", "these", "those", "it", "its",
    "i", "we", "you", "he", "she", "they", "me", "us", "him", "her", "them",
    "my", "our", "your", "his", "their",
    "what", "which", "who", "whom", "when", "where", "why", "how",
    "if", "then", "else", "than",
    "just", "also", "very", "too", "quite", "rather",
    "file", "files", "code", "function", "error", "bug", "issue", "fix",
    "please", "help", "problem", "wrong", "broken", "doesn",
]);

/**
 * Extract meaningful search tokens from an issue query.
 * Removes stopwords, splits on common separators, and deduplicates.
 */
function extractQueryTokens(query: string): string[] {
    const raw = query
        .toLowerCase()
        .replace(/[^a-z0-9_\-./\\@#]/g, " ") // keep code-relevant characters
        .split(/\s+/)
        .filter(t => t.length > 1 && !STOPWORDS.has(t));

    return [...new Set(raw)];
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Map a query (issue title, error message, etc.) to relevant code locations.
 *
 * @param query       Free-text query string
 * @param index       Pre-built search index
 * @param fileNodes   Full list of file nodes (for architectural scoring)
 * @param maxResults  Maximum candidates to return (default: 20)
 */
export function mapIssueToCode(
    query: string,
    index: SearchIndex,
    fileNodes: FileNode[],
    maxResults = 20,
): IssueMappingResult {
    const tokens = extractQueryTokens(query);

    if (tokens.length === 0) {
        return {
            query,
            candidates: [],
            hotspots: [],
            relevantSymbols: [],
            totalMatches: 0,
        };
    }

    // ── Run search across all types ───────────────────────────────────────────
    // Search for files, exports, and tests separately then merge
    const fileResults   = runSearch(index, tokens.join(" "), { type: "file",   limit: maxResults * 2 });
    const exportResults = runSearch(index, tokens.join(" "), { type: "export", limit: maxResults });
    const testResults   = runSearch(index, tokens.join(" "), { type: "test",   limit: maxResults });

    // ── Build file node lookup ────────────────────────────────────────────────
    const fileNodeMap = new Map<string, FileNode>();
    for (const f of fileNodes) fileNodeMap.set(f.id, f);

    // ── Aggregate scores per file ─────────────────────────────────────────────
    const candidateMap = new Map<string, {
        matchScore: number;
        matchReasons: string[];
        functions: Set<string>;
    }>();

    // File matches
    for (const r of fileResults) {
        const filePath = r.entry.filePath;
        const existing = candidateMap.get(filePath) ?? {
            matchScore: 0, matchReasons: [], functions: new Set(),
        };
        existing.matchScore += r.score;
        existing.matchReasons.push(`file match: "${r.matchedTokens.join(", ")}" (+${r.score})`);
        candidateMap.set(filePath, existing);
    }

    // Export/function matches — boost the file they belong to
    for (const r of exportResults) {
        const filePath = r.entry.filePath;
        const existing = candidateMap.get(filePath) ?? {
            matchScore: 0, matchReasons: [], functions: new Set(),
        };
        existing.matchScore += r.score * 0.8; // slightly lower weight than direct file match
        existing.matchReasons.push(`export "${r.entry.name}" matched (+${Math.round(r.score * 0.8)})`);
        existing.functions.add(r.entry.name);
        candidateMap.set(filePath, existing);
    }

    // Test matches — boost covered files
    for (const r of testResults) {
        const filePath = r.entry.filePath;
        const existing = candidateMap.get(filePath) ?? {
            matchScore: 0, matchReasons: [], functions: new Set(),
        };
        existing.matchScore += r.score * 0.5;
        existing.matchReasons.push(`test "${r.entry.name}" matched (+${Math.round(r.score * 0.5)})`);
        candidateMap.set(filePath, existing);
    }

    // ── Apply architectural importance boost ──────────────────────────────────
    for (const [filePath, data] of candidateMap) {
        const node = fileNodeMap.get(filePath);
        if (node) {
            const archBoost = Math.min(20, (node.architecturalImportance ?? 0) * 0.3);
            if (archBoost > 0) {
                data.matchScore += archBoost;
                data.matchReasons.push(`architectural importance boost (+${Math.round(archBoost)})`);
            }
        }
    }

    // ── Build ranked candidates ───────────────────────────────────────────────
    const candidates: IssueMappingCandidate[] = [...candidateMap.entries()]
        .map(([filePath, data]) => {
            const node = fileNodeMap.get(filePath);
            return {
                filePath,
                matchScore: Math.min(100, Math.round(data.matchScore)),
                matchReasons: data.matchReasons,
                functions: [...data.functions],
                isEntryPoint: node?.isEntryPoint ?? false,
                isDeadCode: node?.isDeadCode ?? false,
            };
        })
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, maxResults);

    // ── Hotspots: top 5 by architectural importance among matches ──────────────
    const hotspots = candidates
        .filter(c => !c.isDeadCode)
        .sort((a, b) => {
            const aArch = fileNodeMap.get(a.filePath)?.architecturalImportance ?? 0;
            const bArch = fileNodeMap.get(b.filePath)?.architecturalImportance ?? 0;
            return bArch - aArch;
        })
        .slice(0, 5)
        .map(c => c.filePath);

    // ── Relevant symbols: all matched function names ──────────────────────────
    const relevantSymbols = [...new Set(
        exportResults.map(r => r.entry.name)
    )].slice(0, 20);

    return {
        query,
        candidates,
        hotspots,
        relevantSymbols,
        totalMatches: candidates.length,
    };
}
