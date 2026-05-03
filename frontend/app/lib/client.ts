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
} from "./types";

import type { AnalyzeResponse, StatusResponse, SearchResponse, IssueMappingResult, IssueMapRequest, IssueMapResult } from "./types";

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

  return res.json();
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
    throw new Error(err.error || `HTTP ${res.status}`);
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
