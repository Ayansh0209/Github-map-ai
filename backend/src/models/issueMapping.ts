// models/issueMapping.ts
// ─────────────────────────────────────────────────────────────────────────────
// Issue mapping result types — the output shape of the deterministic
// keyword mapper (issueMapper.ts).
//
// These types describe what mapIssueToCode() returns:
// the ranked list of candidate files and functions for a given issue query.
// ─────────────────────────────────────────────────────────────────────────────

export interface CandidateFile {
    filePath: string;
    score: number;
    matchedReasons: string[];
}

export interface CandidateFunction {
    functionId: string;
    filePath: string;
    score: number;
    matchedReasons: string[];
}

export interface IssueMappingResult {
    issueText: string;
    matchedKeywords: string[];
    topFiles: CandidateFile[];
    topFunctions: CandidateFunction[];
    confidenceScore: number;
}
