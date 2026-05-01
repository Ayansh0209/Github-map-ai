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
    CandidateFile,
    CandidateFunction,
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
        .replace(/[^a-zA-Z0-9_\-./\\@#:]/g, " ") // keep code-relevant characters, including colons for module/function hints
        .split(/\s+/)
        .filter(t => t.length > 1 && !STOPWORDS.has(t.toLowerCase()));

    const expanded = new Set<string>();

    for (const token of raw) {
        expanded.add(token.toLowerCase());
        
        // If camelCase or PascalCase, split it
        if (/^[a-z]+[A-Z][a-zA-Z]*$/.test(token) || /^[A-Z][a-z]+[A-Z][a-zA-Z]*$/.test(token)) {
            const parts = token.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
            for (const p of parts) if (p.length > 1) expanded.add(p.toLowerCase());
        }

        // If path-like, split by slashes
        if (token.includes("/") || token.includes("\\")) {
            const parts = token.split(/[/\\.]/);
            for (const p of parts) if (p.length > 1) expanded.add(p.toLowerCase());
        }
    }

    return [...expanded];
}

// ── Main export ───────────────────────────────────────────────────────────────

export function mapIssueToCode(
    query: string,
    index: SearchIndex,
    maxResults = 10,
): IssueMappingResult {
    const tokens = extractQueryTokens(query);

    if (tokens.length === 0) {
        return {
            issueText: query,
            matchedKeywords: [],
            topFiles: [],
            topFunctions: [],
            confidenceScore: 0,
        };
    }

    // ── Run search across all types ───────────────────────────────────────────
    const fileResults   = runSearch(index, tokens.join(" "), { type: "file",   limit: maxResults * 2, scoreThreshold: 20 });
    const exportResults = runSearch(index, tokens.join(" "), { type: "export", limit: maxResults * 2, scoreThreshold: 20 });
    const testResults   = runSearch(index, tokens.join(" "), { type: "test",   limit: maxResults,     scoreThreshold: 20 });

    // ── Aggregate scores per file ─────────────────────────────────────────────
    const candidateFileMap = new Map<string, {
        score: number;
        reasons: string[];
    }>();

    for (const r of fileResults) {
        const filePath = r.entry.filePath;
        const existing = candidateFileMap.get(filePath) ?? { score: 0, reasons: [] };
        existing.score += r.score;
        existing.reasons.push(`file match: "${r.matchedTokens.join(", ")}" (+${Math.round(r.score)})`);
        candidateFileMap.set(filePath, existing);
    }

    // ── Aggregate scores per function ─────────────────────────────────────────
    const candidateFunctionMap = new Map<string, {
        filePath: string;
        score: number;
        reasons: string[];
    }>();

    for (const r of exportResults) {
        const funcId = r.entry.id;
        const existing = candidateFunctionMap.get(funcId) ?? {
            filePath: r.entry.filePath,
            score: 0,
            reasons: [],
        };
        existing.score += r.score;
        existing.reasons.push(`export match: "${r.entry.name}" (+${Math.round(r.score)})`);
        candidateFunctionMap.set(funcId, existing);

        // Boost the parent file as well
        const fExisting = candidateFileMap.get(r.entry.filePath) ?? { score: 0, reasons: [] };
        fExisting.score += r.score * 0.8; 
        fExisting.reasons.push(`contains matching export "${r.entry.name}" (+${Math.round(r.score * 0.8)})`);
        candidateFileMap.set(r.entry.filePath, fExisting);
    }

    for (const r of testResults) {
        const filePath = r.entry.filePath;
        const existing = candidateFileMap.get(filePath) ?? { score: 0, reasons: [] };
        existing.score += r.score * 0.5;
        existing.reasons.push(`test coverage match: "${r.entry.name}" (+${Math.round(r.score * 0.5)})`);
        candidateFileMap.set(filePath, existing);
    }

    // ── Build ranked candidates ───────────────────────────────────────────────
    const topFiles: CandidateFile[] = [...candidateFileMap.entries()]
        .map(([filePath, data]) => ({
            filePath,
            score: Math.min(100, Math.round(data.score)),
            matchedReasons: data.reasons,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

    const topFunctions: CandidateFunction[] = [...candidateFunctionMap.entries()]
        .map(([functionId, data]) => ({
            functionId,
            filePath: data.filePath,
            score: Math.min(100, Math.round(data.score)),
            matchedReasons: data.reasons,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

    // Calculate an overall confidence based on the top scores
    let confidenceScore = 0;
    if (topFiles.length > 0) confidenceScore = topFiles[0].score;
    if (topFunctions.length > 0 && topFunctions[0].score > confidenceScore) {
        confidenceScore = topFunctions[0].score;
    }

    return {
        issueText: query,
        matchedKeywords: tokens,
        topFiles,
        topFunctions,
        confidenceScore,
    };
}
