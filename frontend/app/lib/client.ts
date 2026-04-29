// All API calls go through here, nowhere else

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

// ── Types ─────────────────────────────────────────────────────────────────────

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
}

export interface GraphStats {
  totalFiles: number;
  parsedFiles: number;
  totalFunctions: number;
  totalImportEdges: number;
  totalCallEdges: number;
  testFiles: number;
  entryPoints: number;
}

export interface FileGraphPayload {
  repoId: string;
  commitSha: string;
  generatedAt: string;
  stats: GraphStats;
  files: FileNodeDTO[];
  importEdges: ImportEdgeDTO[];
}

export interface FileNodeDTO {
  id: string;
  label: string;
  language: string;
  path: string;
  sizeBytes: number;
  lineCount: number;
  parseStatus: string;
  kind: string;
  isEntryPoint: boolean;
  externalImports: string[];
  unresolvedImports: string[];
}

export interface ImportEdgeDTO {
  source: string;
  target: string;
  kind: string;
  symbols: string[];
  isTypeOnly: boolean;
}

export interface FunctionNodeDTO {
  id: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  kind: string;
  visibility?: string;
  parentId?: string;
  calls: string[];
  calledBy: string[];
  analysisConfidence: string;
}

export interface FunctionFilePayload {
  fileId: string;
  functions: FunctionNodeDTO[];
  callEdges: { source: string; target: string; kind: string }[];
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function submitAnalysis(repoUrl: string): Promise<AnalyzeResponse> {
  const res = await fetch(`${API_BASE}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export async function getJobStatus(jobId: string): Promise<StatusResponse> {
  const res = await fetch(`${API_BASE}/status/${jobId}`);

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}
