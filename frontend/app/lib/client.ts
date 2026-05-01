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
} from "./types";

import type { AnalyzeResponse, StatusResponse, SearchResponse } from "./types";

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
