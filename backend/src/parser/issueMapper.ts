// src/parser/issueMapper.ts
// ─────────────────────────────────────────────────────────────────────────────
// Graph traversal engine for issue-to-code mapping.
//
// WHAT THIS FILE DOES NOW (Phase 2):
//   Given a SearchIntent, navigate the RetrievalIndex graph to find candidate
//   files through:
//     1. Direct keyword match against function names, file paths, semanticRole
//     2. Barrel expansion (barrels → real implementation files)
//     3. One-hop neighborhood (importedBy + imports of matched files)
//     4. PR-based files (strongest signal — always included if available)
//
//   Returns a CANDIDATE SET, NOT a ranked list.
//   Ranking is the AI's job, not this module's job.
//
// BACKWARD COMPATIBILITY:
//   If the RetrievalIndex is not in Redis (repos analyzed before Phase 1
//   shipped), this module falls back to the existing inline-index keyword
//   search behavior. Nothing breaks for already-analyzed repos.
//
// WHAT THIS FILE NO LONGER DOES:
//   - It is no longer the ranking authority
//   - It does not score files for the AI
//   - It does not bias the AI with keyword confidence scores
// ─────────────────────────────────────────────────────────────────────────────

import type {
    SearchIndex,
    SearchIndexEntry,
    IssueMappingResult,
    CandidateFile,
    CandidateFunction,
} from "../models/schema";
import type { RetrievalIndex, RetrievalFileEntry } from "../models/retrieval";
import type { SearchIntent } from "./issueUnderstanding";
import type { LinkedPR } from "../github/issueClient";
import { searchIndex as runSearch } from "../search/queryEngine";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The output of the new graph traversal mapper.
 * A candidate set — not a ranked list. The AI ranks, not the mapper.
 */
export interface CandidateSet {
    /** Files found through graph traversal, with source annotation */
    files: CandidateFileEntry[];
    /** Whether the RetrievalIndex was used (true) or inline fallback (false) */
    usedRetrievalIndex: boolean;
}

export interface CandidateFileEntry {
    fileId: string;
    /** How this file entered the candidate set */
    source: "pr" | "keyword" | "barrel-expansion" | "neighborhood" | "entry-point";
    /** Raw match score for tie-breaking only — NOT passed to AI */
    rawScore: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum candidate set size before neighborhood expansion.
 *
 * Reasoning: Neighborhood expansion can multiply the candidate count quickly.
 * We cap direct matches at 15 before expansion so the total stays manageable.
 * The snippet fetcher will further narrow this by scoring functions.
 */
const MAX_DIRECT_CANDIDATES = 15;

/**
 * Maximum total candidates after neighborhood expansion.
 *
 * Reasoning: The snippet fetcher fetches real code from GitHub. Each file
 * is a GitHub API call. 30 is the practical upper bound before we risk
 * rate limiting and slow response times.
 */
const MAX_TOTAL_CANDIDATES = 30;

// ── Graph traversal (new path — uses RetrievalIndex) ─────────────────────────

/**
 * Check if a function name or file path matches any of the search intent signals.
 *
 * Matching strategy:
 *   - Each entity/operation from SearchIntent is checked against the name
 *   - We use substring matching (not exact) because issue text rarely contains
 *     exact function names — "event" should match "createEvent", "updateEvent"
 *   - Score = number of signals that match (higher = more relevant)
 */
function scoreAgainstIntent(
    text: string,
    intent: SearchIntent,
): number {
    const lower = text.toLowerCase();
    let score = 0;

    for (const entity of intent.entities) {
        if (lower.includes(entity.toLowerCase())) score += 2;
    }
    for (const op of intent.operations) {
        if (lower.includes(op.toLowerCase())) score += 1;
    }
    for (const concept of intent.concepts) {
        if (lower.includes(concept.toLowerCase())) score += 1;
    }

    return score;
}

/**
 * Expand barrel files to their real implementation targets.
 *
 * Barrel files (index.ts that only re-exports) dominate keyword searches
 * because they reference many names. But they contain no code worth reading.
 * This function replaces barrel fileIds with their actual implementation targets.
 *
 * @param fileIds    Set of candidate fileIds (may include barrels)
 * @param fileMap    Map from fileId → RetrievalFileEntry
 * @returns          Updated set with barrels replaced by their targets
 */
function expandBarrels(
    fileIds: Set<string>,
    fileMap: Map<string, RetrievalFileEntry>,
): Set<string> {
    const expanded = new Set<string>();

    for (const fileId of fileIds) {
        const entry = fileMap.get(fileId);
        if (entry?.isBarrel && entry.barrelTargets.length > 0) {
            // Replace barrel with its real targets
            for (const target of entry.barrelTargets) {
                expanded.add(target);
            }
        } else {
            expanded.add(fileId);
        }
    }

    return expanded;
}

/**
 * Add one-hop neighbors (importedBy + imports) for each candidate file.
 *
 * Reasoning: if a function is in a file that is imported by many other files,
 * the bug might actually be in those importers. Similarly, if a file imports
 * something suspicious, that import target may be the root cause.
 *
 * We only add one hop (not two) because two hops expand the candidate set
 * too aggressively in large codebases.
 *
 * @param directCandidates   Already-found candidate fileIds
 * @param fileMap            Map from fileId → RetrievalFileEntry
 * @param maxToAdd           Maximum neighbors to add (prevents explosion)
 */
function addNeighborhood(
    directCandidates: Set<string>,
    fileMap: Map<string, RetrievalFileEntry>,
    maxToAdd: number,
): Set<string> {
    const result = new Set<string>(directCandidates);
    let added = 0;

    for (const fileId of directCandidates) {
        if (added >= maxToAdd) break;
        const entry = fileMap.get(fileId);
        if (!entry) continue;

        // Add files that import this candidate (importedBy)
        // Priority: importedBy files because they call INTO our candidate
        // which means they might be the real entry point for the bug
        for (const importer of entry.importedBy.slice(0, 3)) {
            if (!result.has(importer) && added < maxToAdd) {
                result.add(importer);
                added++;
            }
        }

        // Add files this candidate imports (imports)
        // These are the dependencies — the bug might be in a dependency
        for (const dep of entry.imports.slice(0, 2)) {
            if (!result.has(dep) && added < maxToAdd) {
                result.add(dep);
                added++;
            }
        }
    }

    return result;
}

/**
 * Core graph traversal using the RetrievalIndex.
 *
 * Steps:
 *   1. Score each file's functions against the SearchIntent
 *   2. Score file paths and semanticRole against the intent
 *   3. Collect high-scoring files as direct candidates
 *   4. Expand barrel files to their real targets
 *   5. Add one-hop neighborhood
 *   6. Prepend any PR-based files (strongest signal)
 */
function traverseRetrievalGraph(
    intent: SearchIntent,
    retrieval: RetrievalIndex,
    linkedPRs: LinkedPR[],
    graphFileIds: Set<string>,
): CandidateSet {
    // Build file map for O(1) lookup
    const fileMap = new Map<string, RetrievalFileEntry>();
    for (const f of retrieval.files) {
        fileMap.set(f.fileId, f);
    }

    // ── PR-based files (always included, highest priority) ────────────────────
    const prFileIds = new Set<string>();
    for (const pr of linkedPRs) {
        for (const changedFile of pr.changedFiles) {
            // Only include files that exist in the graph
            if (graphFileIds.has(changedFile)) {
                prFileIds.add(changedFile);
            }
        }
    }

    // ── Direct keyword traversal ──────────────────────────────────────────────
    const directScores = new Map<string, number>();

    for (const fileEntry of retrieval.files) {
        // Skip barrels in direct scoring — they'll be expanded later
        // (but don't skip them entirely — we need to find them first)
        let fileScore = 0;

        // Score file path against intent
        fileScore += scoreAgainstIntent(fileEntry.fileId, intent);

        // Score semanticRole (role="auth" when intent has auth concepts gets a boost)
        if (fileEntry.semanticRole !== "unknown" && fileEntry.semanticRole !== "barrel") {
            fileScore += scoreAgainstIntent(fileEntry.semanticRole, intent);
        }

        // Score individual functions against intent
        for (const fn of fileEntry.functions) {
            const fnScore = scoreAgainstIntent(fn.name, intent);
            if (fnScore > 0) {
                // Function match boosts its parent file
                fileScore += fnScore * 1.5;
            }
        }

        if (fileScore > 0) {
            directScores.set(fileEntry.fileId, fileScore);
        }
    }

    // Sort by score and take top N
    const sortedDirect = [...directScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_DIRECT_CANDIDATES);

    const directCandidateIds = new Set<string>(sortedDirect.map(([id]) => id));

    // ── Barrel expansion ──────────────────────────────────────────────────────
    const afterExpansion = expandBarrels(directCandidateIds, fileMap);

    // ── Neighborhood expansion ────────────────────────────────────────────────
    const maxNeighbors = MAX_TOTAL_CANDIDATES - prFileIds.size - afterExpansion.size;
    const withNeighborhood = addNeighborhood(afterExpansion, fileMap, Math.max(0, maxNeighbors));

    // ── Assemble final candidate set ──────────────────────────────────────────
    const files: CandidateFileEntry[] = [];
    const seen = new Set<string>();

    // PR files first
    for (const fileId of prFileIds) {
        if (!seen.has(fileId)) {
            files.push({ fileId, source: "pr", rawScore: 200 });
            seen.add(fileId);
        }
    }

    // Direct keyword matches (excluding barrels that were expanded)
    for (const [fileId, score] of sortedDirect) {
        if (seen.has(fileId)) continue;
        const entry = fileMap.get(fileId);
        if (entry?.isBarrel) continue; // barrel was expanded — skip original
        files.push({ fileId, source: "keyword", rawScore: score });
        seen.add(fileId);
    }

    // Barrel expansion targets
    for (const fileId of afterExpansion) {
        if (seen.has(fileId)) continue;
        if (!directCandidateIds.has(fileId)) {
            // It's a barrel target (wasn't in direct candidates)
            files.push({ fileId, source: "barrel-expansion", rawScore: 50 });
            seen.add(fileId);
        }
    }

    // Neighborhood files
    for (const fileId of withNeighborhood) {
        if (seen.has(fileId)) continue;
        files.push({ fileId, source: "neighborhood", rawScore: 20 });
        seen.add(fileId);
    }

    return { files: files.slice(0, MAX_TOTAL_CANDIDATES), usedRetrievalIndex: true };
}

/**
 * Vague issue path: return entry-point files and highly-connected files
 * as a broad starting set for the AI to explore.
 *
 * When the issue is vague (isVague=true), we cannot do meaningful keyword
 * traversal. Instead, we give the AI a representative cross-section of
 * the codebase — entry points, auth files, and data access files.
 */
function getVagueFallbackCandidates(
    retrieval: RetrievalIndex,
    linkedPRs: LinkedPR[],
    graphFileIds: Set<string>,
): CandidateSet {
    const files: CandidateFileEntry[] = [];
    const seen = new Set<string>();

    // PR files first (always highest priority)
    for (const pr of linkedPRs) {
        for (const changedFile of pr.changedFiles) {
            if (graphFileIds.has(changedFile) && !seen.has(changedFile)) {
                files.push({ fileId: changedFile, source: "pr", rawScore: 200 });
                seen.add(changedFile);
            }
        }
    }

    // High-signal file roles: auth, service, resolver, controller, middleware
    const HIGH_SIGNAL_ROLES = new Set(["auth", "service", "resolver", "controller", "middleware", "repository"]);

    const byRole = retrieval.files
        .filter(f => HIGH_SIGNAL_ROLES.has(f.semanticRole) && !seen.has(f.fileId))
        .slice(0, 10);

    for (const f of byRole) {
        files.push({ fileId: f.fileId, source: "entry-point", rawScore: 30 });
        seen.add(f.fileId);
    }

    // Files with auth checks (likely to be relevant for many issues)
    const authFiles = retrieval.files
        .filter(f => !seen.has(f.fileId) && f.functions.some(fn => fn.hasAuthCheck))
        .slice(0, 5);

    for (const f of authFiles) {
        files.push({ fileId: f.fileId, source: "entry-point", rawScore: 25 });
        seen.add(f.fileId);
    }

    return { files: files.slice(0, MAX_TOTAL_CANDIDATES), usedRetrievalIndex: true };
}

// ── Main new-path entry point ─────────────────────────────────────────────────

/**
 * Navigate the RetrievalIndex graph to find candidate files for an issue.
 *
 * This is the Phase 2 entry point for issue mapping. It requires the
 * RetrievalIndex to be available in Redis (populated by Phase 1 parsing).
 *
 * @param intent       Structured intent from issueUnderstanding.ts
 * @param retrieval    RetrievalIndex loaded from Redis
 * @param linkedPRs    Linked pull requests (strongest signal)
 * @param graphFileIds Set of all fileIds in the visualization graph (for filtering)
 * @returns            Candidate set for the snippet fetcher
 */
export function traverseGraph(
    intent: SearchIntent,
    retrieval: RetrievalIndex,
    linkedPRs: LinkedPR[],
    graphFileIds: Set<string>,
): CandidateSet {
    if (intent.isVague && linkedPRs.length === 0) {
        // Vague issue with no PR context — use broad fallback
        return getVagueFallbackCandidates(retrieval, linkedPRs, graphFileIds);
    }

    return traverseRetrievalGraph(intent, retrieval, linkedPRs, graphFileIds);
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY FALLBACK — backward compatibility for repos without RetrievalIndex
// ─────────────────────────────────────────────────────────────────────────────
//
// The functions below are preserved exactly from Phase 1.
// They are called when the RetrievalIndex is not available in Redis.
// This ensures no regressions for repos analyzed before Phase 1 shipped.

/** @deprecated Use traverseGraph() instead when RetrievalIndex is available */
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

/** @deprecated Use traverseGraph() instead when RetrievalIndex is available */
function extractQueryTokens(query: string): string[] {
    const raw = query
        .replace(/[^a-zA-Z0-9_\-./\\@#:]/g, " ")
        .split(/\s+/)
        .filter(t => t.length > 1 && !STOPWORDS.has(t.toLowerCase()));

    const expanded = new Set<string>();
    for (const token of raw) {
        expanded.add(token.toLowerCase());
        if (/^[a-z]+[A-Z][a-zA-Z]*$/.test(token) || /^[A-Z][a-z]+[A-Z][a-zA-Z]*$/.test(token)) {
            const parts = token.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
            for (const p of parts) if (p.length > 1) expanded.add(p.toLowerCase());
        }
        if (token.includes("/") || token.includes("\\")) {
            const parts = token.split(/[/\\.]/);
            for (const p of parts) if (p.length > 1) expanded.add(p.toLowerCase());
        }
    }
    return [...expanded];
}

/**
 * Legacy keyword-based issue mapping.
 * Used as fallback when RetrievalIndex is not available.
 *
 * @deprecated Use traverseGraph() instead
 */
export function mapIssueToCode(
    query: string,
    index: SearchIndex,
    maxResults = 10,
): IssueMappingResult {
    const tokens = extractQueryTokens(query);

    if (tokens.length === 0) {
        return { issueText: query, matchedKeywords: [], topFiles: [], topFunctions: [], confidenceScore: 0 };
    }

    const fileResults   = runSearch(index, tokens.join(" "), { type: "file",   limit: maxResults * 2, scoreThreshold: 20 });
    const exportResults = runSearch(index, tokens.join(" "), { type: "export", limit: maxResults * 2, scoreThreshold: 20 });
    const testResults   = runSearch(index, tokens.join(" "), { type: "test",   limit: maxResults,     scoreThreshold: 20 });

    const candidateFileMap = new Map<string, { score: number; reasons: string[] }>();

    for (const r of fileResults) {
        const existing = candidateFileMap.get(r.entry.filePath) ?? { score: 0, reasons: [] };
        existing.score += r.score;
        existing.reasons.push(`file match: "${r.matchedTokens.join(", ")}" (+${Math.round(r.score)})`);
        candidateFileMap.set(r.entry.filePath, existing);
    }

    const candidateFunctionMap = new Map<string, { filePath: string; score: number; reasons: string[] }>();

    for (const r of exportResults) {
        const funcId = r.entry.id;
        const existing = candidateFunctionMap.get(funcId) ?? { filePath: r.entry.filePath, score: 0, reasons: [] };
        existing.score += r.score;
        existing.reasons.push(`export match: "${r.entry.name}" (+${Math.round(r.score)})`);
        candidateFunctionMap.set(funcId, existing);

        const fExisting = candidateFileMap.get(r.entry.filePath) ?? { score: 0, reasons: [] };
        fExisting.score += r.score * 0.8;
        fExisting.reasons.push(`contains matching export "${r.entry.name}" (+${Math.round(r.score * 0.8)})`);
        candidateFileMap.set(r.entry.filePath, fExisting);
    }

    for (const r of testResults) {
        const existing = candidateFileMap.get(r.entry.filePath) ?? { score: 0, reasons: [] };
        existing.score += r.score * 0.5;
        existing.reasons.push(`test coverage match: "${r.entry.name}" (+${Math.round(r.score * 0.5)})`);
        candidateFileMap.set(r.entry.filePath, existing);
    }

    const topFiles: CandidateFile[] = [...candidateFileMap.entries()]
        .map(([filePath, data]) => ({ filePath, score: Math.min(100, Math.round(data.score)), matchedReasons: data.reasons }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

    const topFunctions: CandidateFunction[] = [...candidateFunctionMap.entries()]
        .map(([functionId, data]) => ({ functionId, filePath: data.filePath, score: Math.min(100, Math.round(data.score)), matchedReasons: data.reasons }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

    let confidenceScore = 0;
    if (topFiles.length > 0) confidenceScore = topFiles[0].score;
    if (topFunctions.length > 0 && topFunctions[0].score > confidenceScore) confidenceScore = topFunctions[0].score;

    return { issueText: query, matchedKeywords: tokens, topFiles, topFunctions, confidenceScore };
}

/**
 * Builds a SearchIndex from a file list (legacy inline fallback).
 * Used when neither RetrievalIndex nor Redis search index is available.
 *
 * @deprecated Use traverseGraph() instead
 */
export function buildInlineSearchIndex(
    files: Array<{ id: string; label: string; architecturalImportance?: number }>,
): SearchIndex {
    const entries: SearchIndexEntry[] = files.map(f => {
        const pathTokens = f.id.replace(/[^a-zA-Z0-9]/g, " ").split(/\s+/).filter(t => t.length > 1).map(t => t.toLowerCase());
        const labelTokens = f.label.replace(/[^a-zA-Z0-9]/g, " ").split(/\s+/).filter(t => t.length > 1).map(t => t.toLowerCase());
        const tokens = [...new Set([...pathTokens, ...labelTokens])];
        return { id: f.id, type: "file" as const, name: f.label, filePath: f.id, tokens, hubScore: f.architecturalImportance ?? 0 };
    });
    return { entries, generatedAt: new Date().toISOString() };
}
