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
}

export interface ImportEdgeDTO {
  source: string;        // FileNode ID
  target: string;        // FileNode ID
  kind: "static" | "dynamic" | "re-export";
  symbols: string[];
  isTypeOnly: boolean;
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
  kind: "function" | "arrow" | "method" | "constructor" | "getter" | "setter" | "async" | "unknown";
  visibility?: "public" | "private" | "protected";
  parentId?: string;
  calls: string[];       // FunctionNode IDs this calls
  calledBy: string[];    // FunctionNode IDs that call this
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
