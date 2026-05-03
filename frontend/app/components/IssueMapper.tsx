"use client";

// IssueMapper.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Compact sidebar widget for mapping a GitHub issue to repo files.
//
// Usage:
//   Paste a full GitHub issue URL:  https://github.com/owner/repo/issues/123
//   Or a bare issue number:         123
//
// On submit, calls POST /issue-map and returns the result to the parent.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useRef } from "react";
import { mapIssue } from "../lib/client";
import type { IssueMapResult, FileNodeDTO, FunctionNodeDTO } from "../lib/types";

interface IssueMapperProps {
  owner: string;
  repo: string;
  commitSha: string;
  files: FileNodeDTO[];
  functions?: FunctionNodeDTO[];
  onResult: (result: IssueMapResult) => void;
  onClear: () => void;
  issueResult: IssueMapResult | null;
  isLoading: boolean;
  error: string | null;
  setLoading: (v: boolean) => void;
  setError: (v: string | null) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseIssueInput(input: string): number | null {
  const trimmed = input.trim();

  // Bare number: "7145"
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  // Full GitHub URL: https://github.com/owner/repo/issues/7145
  const urlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/);
  if (urlMatch) {
    return parseInt(urlMatch[1], 10);
  }

  return null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function IssueMapper({
  owner,
  repo,
  commitSha,
  files,
  functions = [],
  onResult,
  onClear,
  issueResult,
  isLoading,
  error,
  setLoading,
  setError,
}: IssueMapperProps) {
  const [inputValue, setInputValue] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async () => {
    setValidationError(null);
    setError(null);

    const issueNumber = parseIssueInput(inputValue);
    if (!issueNumber) {
      setValidationError("Enter an issue number (e.g. 7145) or a GitHub issue URL");
      return;
    }

    setLoading(true);
    try {
      const result = await mapIssue({
        owner,
        repo,
        commitSha,
        issueNumber,
        graphData: {
          files: files.map(f => ({
            id: f.id,
            label: f.label,
            architecturalImportance: f.architecturalImportance ?? 0,
          })),
          functions: functions.map(fn => ({
            id: fn.id,
            name: fn.name,
            filePath: fn.filePath,
          })),
        },
      });
      onResult(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSubmit();
  };

  const handleClear = () => {
    setInputValue("");
    setValidationError(null);
    setError(null);
    onClear();
  };

  const displayError = validationError || error;

  return (
    <div
      className="rounded-xl p-3 space-y-2.5"
      style={{
        background: "#0d1117",
        border: "1px solid #30363d",
        marginBottom: "12px",
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <span style={{ fontSize: 14 }}>🔍</span>
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: "#8b949e" }}
        >
          Map an Issue
        </span>
        {issueResult && (
          <button
            onClick={handleClear}
            className="ml-auto text-[10px] px-2 py-0.5 rounded transition-colors"
            style={{
              color: "#8b949e",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid #30363d",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#e6edf3"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "#8b949e"; }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Input + Button */}
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={e => { setInputValue(e.target.value); setValidationError(null); }}
          onKeyDown={handleKeyDown}
          placeholder="Paste issue URL or number..."
          className="flex-1 px-2.5 py-1.5 rounded-lg text-xs outline-none"
          style={{
            background: "#161b22",
            border: `1px solid ${displayError ? "#f85149" : "#30363d"}`,
            color: "#e6edf3",
            fontFamily: "monospace",
            minWidth: 0,
          }}
          disabled={isLoading}
        />
        <button
          onClick={handleSubmit}
          disabled={isLoading || !inputValue.trim()}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all shrink-0 disabled:opacity-40"
          style={{
            background: isLoading ? "rgba(88,166,255,0.08)" : "rgba(88,166,255,0.15)",
            color: "#58a6ff",
            border: "1px solid rgba(88,166,255,0.25)",
          }}
        >
          {isLoading ? (
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-3 border-2 rounded-full animate-spin"
                style={{ borderColor: "#58a6ff", borderTopColor: "transparent" }}
              />
              Analyzing...
            </span>
          ) : (
            "Find files"
          )}
        </button>
      </div>

      {/* Validation / API error */}
      {displayError && (
        <p className="text-[10px]" style={{ color: "#f85149" }}>
          {displayError}
        </p>
      )}

      {/* Result summary (when there's a result and no error) */}
      {issueResult && !displayError && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
              style={{
                background: issueResult.source === "cache"
                  ? "rgba(56,189,248,0.1)"
                  : issueResult.source === "ai"
                    ? "rgba(168,85,247,0.1)"
                    : "rgba(63,185,80,0.1)",
                color: issueResult.source === "cache"
                  ? "#38bdf8"
                  : issueResult.source === "ai"
                    ? "#a855f7"
                    : "#3fb950",
              }}
            >
              {issueResult.source === "cache" ? "⚡ cached" : issueResult.source === "ai" ? "✨ AI" : "📊 deterministic"}
            </span>
            <span className="text-[10px]" style={{ color: "#8b949e" }}>
              {issueResult.affectedFiles.length} file{issueResult.affectedFiles.length !== 1 ? "s" : ""} found
            </span>
            <span
              className="ml-auto text-[10px] font-bold"
              style={{
                color: issueResult.overallConfidence >= 70
                  ? "#22c55e"
                  : issueResult.overallConfidence >= 40
                    ? "#f0883e"
                    : "#8b949e",
              }}
            >
              {issueResult.overallConfidence}%
            </span>
          </div>
          <p
            className="text-[10px] truncate"
            style={{ color: "#484f58" }}
            title={issueResult.issueTitle}
          >
            #{issueResult.issueNumber}: {issueResult.issueTitle}
          </p>
        </div>
      )}
    </div>
  );
}
