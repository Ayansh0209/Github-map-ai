// ── Pure utility functions shared by FileGraph and FunctionGraph ───────────────
// No side effects, no React, no D3 — just data transformations

// ── Language colors ───────────────────────────────────────────────────────────

const LANGUAGE_COLORS: Record<string, string> = {
  typescript: "#3178c6",
  javascript: "#e8a400",
  tsx: "#7c3aed",
  jsx: "#ea580c",
  json: "#6b7280",
  css: "#ec4899",
  html: "#ef4444",
  unknown: "#6b7280",
};

export function getLanguageColor(language: string): string {
  return LANGUAGE_COLORS[language] || LANGUAGE_COLORS.unknown;
}

// ── Node sizing ───────────────────────────────────────────────────────────────

export function getNodeRadius(lineCount: number): number {
  const lines = lineCount || 1;
  return Math.max(6, Math.min(30, Math.sqrt(lines) * 1.5));
}

// ── GitHub link builders ──────────────────────────────────────────────────────

export function makeGitHubFileLink(
  owner: string,
  repo: string,
  commitSha: string,
  filePath: string
): string {
  return `https://github.com/${owner}/${repo}/blob/${commitSha}/${filePath}`;
}

export function makeGitHubLineLink(
  owner: string,
  repo: string,
  commitSha: string,
  filePath: string,
  startLine: number,
  endLine: number
): string {
  return `https://github.com/${owner}/${repo}/blob/${commitSha}/${filePath}#L${startLine}-L${endLine}`;
}

// ── Sanitize file ID ──────────────────────────────────────────────────────────
// Must match backend's sanitizeFileId in builder.ts

export function sanitizeFileId(filePath: string): string {
  return filePath.replace(/[/\\]/g, "-").replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

// ── Function kind badges ──────────────────────────────────────────────────────

const KIND_BADGES: Record<string, string> = {
  function: "fn",
  arrow: "=>",
  method: "method",
  constructor: "ctor",
  getter: "get",
  setter: "set",
  async: "async",
  unknown: "fn",
};

export function getKindBadge(kind: string): string {
  return KIND_BADGES[kind] || "fn";
}

// ── Folder grouping ───────────────────────────────────────────────────────────
// Used by file graph to cluster files in the same directory

export function getFolderGroup(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  if (parts.length <= 1) return "/";
  return parts.slice(0, -1).join("/");
}

// ── Edge styling helpers ──────────────────────────────────────────────────────

export function getEdgeWidth(symbols: string[]): number {
  return Math.max(1, Math.min(4, symbols.length * 0.5));
}

export function getEdgeDashArray(kind: string): string {
  switch (kind) {
    case "dynamic":
      return "6,3";
    case "re-export":
      return "2,2";
    default:
      return "none";
  }
}
