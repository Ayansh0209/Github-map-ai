// All API calls go through here, nowhere else

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

// ── Re-export all types from the centralized types file ───────────────────────
export type {
  AnalyzeResponse,
  StatusResponse,
  GraphStats,
  FileGraphPayload,
  FileNodeDTO,
  ImportEdgeDTO,
  FunctionNodeDTO,
  CallEdgeDTO,
  FunctionFilePayload,
  ViewMode,
  SearchResultItem,
  SearchResponse,
  IssueMappingResult,
  CandidateFile,
  CandidateFunction,
  IssueContext,
  IssueMapResult,
  IssueMapRequest,
  AffectedFile,
  AffectedFunction,
  RepoModuleDTO,
  ModuleDependencyDTO,
  ArchitectureMapResponse,
} from "./types";

import type { AnalyzeResponse, StatusResponse, SearchResponse, IssueMappingResult, IssueMapRequest, IssueMapResult, FunctionFilePayload, ArchitectureMapResponse, FileGraphPayload } from "./types";

// ── Shared types ──────────────────────────────────────────────────────────────

export type IssueSummary = {
  number: number;
  title: string;
  htmlUrl: string;
  labels: string[];
  state: "open" | "closed";
};

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

  console.log('[poll] response size:', res.headers.get('content-length'), 'bytes');
  console.log('[poll] status:', res.status);

  try {
    const data = await res.json();
    console.log('[poll] parsed result keys:', Object.keys(data));
    console.log('[poll] _inlineFileGraph files:', data._inlineFileGraph?.files?.length);
    console.log('[poll] _functionFiles keys:', Object.keys(data._functionFiles ?? {}).length);
    return data;
  } catch (err) {
    console.error('[poll] JSON parse failed:', err);
    console.error('[poll] This usually means the response is too large');
    throw err;
  }
}

export async function searchCode(
  owner: string,
  repo: string,
  query: string,
  type?: "file" | "function" | "export" | "test",
  limit = 30,
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query, owner, repo, limit: limit.toString() });
  if (type) params.set("type", type);

  const res = await fetch(`${API_BASE}/search?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Search failed" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function searchIssues(
  owner: string,
  repo: string,
  query: string,
  limit = 10,
): Promise<IssueMappingResult> {
  const params = new URLSearchParams({ q: query, owner, repo, limit: limit.toString() });
  const res = await fetch(`${API_BASE}/search/issues?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Diagnose failed" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function mapIssue(request: IssueMapRequest): Promise<IssueMapResult> {
  const res = await fetch(`${API_BASE}/issue-map/map`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Issue mapping failed" }));
    const msg = typeof err.error === "string" ? err.error : (err.error?.message || JSON.stringify(err.error) || `HTTP ${res.status}`);
    throw new Error(msg);
  }
  return res.json();
}

export async function fetchRepoIssues(
  owner: string,
  repo: string,
): Promise<{ source: "cache" | "fresh"; issues: IssueSummary[] }> {
  const res = await fetch(`${API_BASE}/issue-map/fetch-issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to fetch issues" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchFileContent(
  owner: string,
  repo: string,
  commitSha: string,
  filePath: string,
): Promise<{ content: string | null; lines: number }> {
  const res = await fetch(`${API_BASE}/file-content`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, commitSha, filePath }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to fetch file content" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}
export async function fetchFileFunctions(
  owner: string,
  repo: string,
  commitSha: string,
  filePath: string
): Promise<FunctionFilePayload> {
  const res = await fetch(`${API_BASE}/functions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, commitSha, fileId: filePath }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchArchitectureMap(
  owner: string,
  repo: string,
  commitSha: string
): Promise<ArchitectureMapResponse> {
  const res = await fetch(`${API_BASE}/architecture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, commitSha }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to fetch architecture map" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch the full file graph for a repo from the backend.
 * The server sends gzipped JSON (Content-Encoding: gzip) — the browser
 * decompresses transparently, so a 30MB graph travels as ~3MB.
 */
export async function fetchFileGraph(
  owner: string,
  repo: string,
  sha?: string,
): Promise<FileGraphPayload> {
  const params = sha ? `?sha=${encodeURIComponent(sha)}` : "";
  const res = await fetch(`${API_BASE}/graph/${owner}/${repo}${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to fetch graph" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}
