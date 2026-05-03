// ── All TypeScript interfaces for CodeMap AI ──────────────────────────────────
// Single source of truth — import from here everywhere

// ── View state ────────────────────────────────────────────────────────────────

export type ViewMode = "file-graph" | "function-graph";

// ── Graph stats ───────────────────────────────────────────────────────────────

export interface GraphStats {
  totalFiles: number;
  parsedFiles: number;
  totalFunctions: number;
  totalImportEdges: number;
  totalCallEdges: number;
  testFiles: number;
  entryPoints: number;
  deadCodeFiles: number;
  workspacePackages: number;
}

// ── File-level types ──────────────────────────────────────────────────────────

export interface FileNodeDTO {
  id: string;            // "src/utils/parser.ts"
  label: string;         // "parser.ts"
  language: string;
  path: string;
  sizeBytes: number;
  lineCount: number;
  parseStatus: "full" | "imports-only" | "skipped";
  kind: "source" | "test" | "config" | "declaration" | "unknown";
  isEntryPoint: boolean;
  externalImports: string[];
  unresolvedImports: string[];
  entryScore?: number;
  entryReasons?: string[];
  testSuites?: string[];
  testCases?: string[];
  cycleScore?: number;
  hubScore?: number;
  architecturalImportance?: number;
  // Phase 3: workspace
  workspacePackage?: string;
  packageRoot?: string;
  packageName?: string;
  // Phase 3: dead code
  deadCodeScore?: number;
  isDeadCode?: boolean;
  unusedExports?: string[];
  orphanSymbols?: string[];
}

export interface ImportEdgeDTO {
  source: string;        // FileNode ID
  target: string;        // FileNode ID
  kind: "static" | "dynamic" | "re-export";
  symbols: string[];
  isTypeOnly: boolean;
  weight?: number;
  isCircular?: boolean;
  isTestCoverage?: boolean;
}

export interface FileGraphPayload {
  repoId: string;
  commitSha: string;
  generatedAt: string;
  stats: GraphStats;
  files: FileNodeDTO[];
  importEdges: ImportEdgeDTO[];
}

// ── Function-level types ──────────────────────────────────────────────────────

export interface FunctionNodeDTO {
  id: string;            // "src/utils/parser.ts::parseImports"
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  isAsync?: boolean;
  kind: "function" | "arrow" | "method" | "constructor" | "getter" | "setter" | "async" | "component" | "hook" | "reducer" | "route-handler" | "middleware" | "test" | "utility" | "callback" | "context-provider" | "unknown";
  visibility?: "public" | "private" | "protected";
  parentId?: string;
  calls: string[];       // FunctionNode IDs this calls
  calledBy: string[];    // FunctionNode IDs that call this
  testCoveredFiles?: string[];
  analysisConfidence: "high" | "medium" | "low";
}

export interface CallEdgeDTO {
  source: string;        // FunctionNode ID
  target: string;        // FunctionNode ID
  kind: "direct" | "method" | "async" | "unknown";
}

export interface FunctionFilePayload {
  fileId: string;        // original path e.g. "src/utils/parser.ts"
  functions: FunctionNodeDTO[];
  callEdges: CallEdgeDTO[];
}

// ── API response types ────────────────────────────────────────────────────────

export interface AnalyzeResponse {
  jobId: string;
  position: number;
  estimatedWaitMs: number;
}

export interface StatusResponse {
  status: "queued" | "processing" | "done" | "failed" | "delayed";
  position?: number;
  progress?: number;
  step?: string;
  error?: string;
  // when done:
  success?: boolean;
  owner?: string;
  repo?: string;
  commitSha?: string;
  defaultBranch?: string;
  stats?: GraphStats;
  _inlineFileGraph?: FileGraphPayload;
  _functionFiles?: Record<string, FunctionFilePayload>;
}

// ── Search types ───────────────────────────────────────────────────────────────

export interface SearchResultItem {
  id: string;
  type: "file" | "function" | "export" | "test";
  name: string;
  filePath: string;
  language?: string;
  kind?: string;
  isEntryPoint?: boolean;
  isDeadCode?: boolean;
  packageName?: string;
  score: number;
  matchedTokens?: string[];
}

export interface SearchResponse {
  query: string;
  total: number;
  results: SearchResultItem[];
}

// ── Diagnose (Issue Mapping) types ────────────────────────────────────────────

export interface CandidateFile {
  filePath: string;
  score: number;            // 0-100 confidence
  matchedReasons: string[]; // why the engine picked this file
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

// ── Issue Mapping types (new /issue-map endpoint) ────────────────────────────

export interface AffectedFile {
  fileId: string;
  confidence: number;  // 0-100
  reason: string;      // one sentence
}

export interface AffectedFunction {
  functionId: string;
  filePath: string;
  confidence: number;
  reason: string;
}

export interface IssueMapResult {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueUrl: string;
  affectedFiles: AffectedFile[];
  affectedFunctions: AffectedFunction[];
  source: "cache" | "deterministic" | "ai";
  overallConfidence: number;
}

export interface IssueMapRequest {
  owner: string;
  repo: string;
  commitSha: string;
  issueNumber: number;
  graphData: {
    files: Array<{ id: string; label: string; architecturalImportance: number }>;
    functions: Array<{ id: string; name: string; filePath: string }>;
  };
}

/**
 * Derived context passed to DetailsPanel when the selected file
 * is part of an issue mapping result.
 */
export interface IssueContext {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  confidence: number;
  reason: string;
}
