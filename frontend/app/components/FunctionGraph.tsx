"use client";

import { useMemo } from "react";
import type {
  FunctionNodeDTO,
  FunctionFilePayload,
} from "../lib/types";
import {
  makeGitHubLineLink,
  getKindBadge,
  sanitizeFileId,
} from "../lib/graphHelpers";

interface FunctionGraphProps {
  selectedFunction: FunctionNodeDTO;
  functionFiles: Record<string, FunctionFilePayload>;
  owner: string;
  repo: string;
  commitSha: string;
  onFunctionNavigate: (fn: FunctionNodeDTO) => void;
  onBackToFileGraph: () => void;
  onBackToFile?: () => void;
}

// ── Resolve function IDs to FunctionNodeDTO objects ───────────────────────────

function resolveFunctionById(
  id: string,
  functionFiles: Record<string, FunctionFilePayload>
): FunctionNodeDTO | null {
  // ID format: "src/utils/parser.ts::parseImports"
  const sepIndex = id.indexOf("::");
  if (sepIndex === -1) return null;

  const filePath = id.substring(0, sepIndex);
  const sanitized = sanitizeFileId(filePath);
  const payload = functionFiles[sanitized];
  if (!payload) return null;

  return payload.functions.find((fn) => fn.id === id) || null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function FunctionGraph({
  selectedFunction,
  functionFiles,
  owner,
  repo,
  commitSha,
  onFunctionNavigate,
  onBackToFileGraph,
  onBackToFile,
}: FunctionGraphProps) {
  // Resolve callers and callees
  const { callers, callees } = useMemo(() => {
    const callerNodes: FunctionNodeDTO[] = [];
    const calleeNodes: FunctionNodeDTO[] = [];

    for (const callerId of selectedFunction.calledBy) {
      const fn = resolveFunctionById(callerId, functionFiles);
      if (fn) callerNodes.push(fn);
    }

    for (const calleeId of selectedFunction.calls) {
      const fn = resolveFunctionById(calleeId, functionFiles);
      if (fn) calleeNodes.push(fn);
    }

    return { callers: callerNodes, callees: calleeNodes };
  }, [selectedFunction, functionFiles]);

  // GitHub line link for selected function
  const githubLineLink = makeGitHubLineLink(
    owner,
    repo,
    commitSha,
    selectedFunction.filePath,
    selectedFunction.startLine,
    selectedFunction.endLine
  );

  // Extract short file name from path
  const shortFile = selectedFunction.filePath.split("/").pop() || selectedFunction.filePath;

  return (
    <div className="w-full" style={{ minHeight: "75vh" }}>
      {/* ── Top bar: Back + Breadcrumb ────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 mb-4 px-2 py-2 flex-wrap"
        style={{ borderBottom: "1px solid #21262d" }}
      >
        {/* Back buttons */}
        <div className="flex items-center gap-2">
          <button
            id="back-to-file-graph-btn"
            onClick={onBackToFileGraph}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:opacity-80"
            style={{ background: "#1c2128", border: "1px solid #30363d", color: "#8b949e" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Graph
          </button>
          {onBackToFile && (
            <button
              id="back-to-file-btn"
              onClick={onBackToFile}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:opacity-80"
              style={{ background: "#1c2128", border: "1px solid #30363d", color: "#8b949e" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
              {shortFile}
            </button>
          )}
        </div>

        {/* Breadcrumb */}
        <div className="flex items-center gap-1 text-xs overflow-hidden">
          <button onClick={onBackToFileGraph} className="hover:opacity-80 transition-opacity" style={{ color: "#8b949e" }}>
            {owner}/{repo}
          </button>
          <span style={{ color: "#484f58" }}>›</span>
          <button
            onClick={onBackToFile ?? onBackToFileGraph}
            className="hover:opacity-80 transition-opacity truncate max-w-[200px]"
            style={{ color: "#8b949e", fontFamily: "var(--font-geist-mono), monospace" }}
          >
            {selectedFunction.filePath}
          </button>
          <span style={{ color: "#484f58" }}>›</span>
          <span style={{ color: "#e6edf3", fontFamily: "var(--font-geist-mono), monospace", fontWeight: 600 }}>
            {selectedFunction.name}()
          </span>
        </div>
      </div>

      {/* ── Three-column layout ───────────────────────────────────────────── */}
      <div
        className="grid gap-6 px-4"
        style={{
          gridTemplateColumns: "1fr auto 1fr",
          minHeight: "500px",
          alignItems: "start",
        }}
      >
        {/* ── LEFT: Callers ─────────────────────────────────────────────── */}
        <div className="space-y-3">
          <div
            className="text-xs font-semibold uppercase tracking-wider mb-3 flex items-center gap-2"
            style={{ color: "#3fb950" }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Callers ({callers.length})
          </div>

          {callers.length === 0 ? (
            <EmptyState>Not called by any tracked function</EmptyState>
          ) : (
            callers.map((fn) => (
              <FunctionCard
                key={fn.id}
                fn={fn}
                borderColor="#3fb950"
                onClick={() => onFunctionNavigate(fn)}
              />
            ))
          )}
        </div>

        {/* ── CENTER: Selected function ─────────────────────────────────── */}
        <div className="flex flex-col items-center gap-4 pt-8">
          {/* Connection lines visual hint */}
          {callers.length > 0 && (
            <div
              className="text-xs"
              style={{ color: "#484f58", marginBottom: "-8px" }}
            >
              ← calls this
            </div>
          )}

          {/* Selected function card */}
          <div
            className="rounded-xl p-5 text-center relative"
            style={{
              width: "220px",
              background: "#1c2128",
              border: "2px solid #f0883e",
              boxShadow: "0 0 20px rgba(240,136,62,0.15)",
            }}
          >
            {/* Kind badge */}
            <span
              className="absolute top-2 right-2 text-[10px] px-1.5 py-0.5 rounded font-medium"
              style={{
                background: "rgba(240,136,62,0.2)",
                color: "#f0883e",
              }}
            >
              {getKindBadge(selectedFunction.kind)}
            </span>

            {/* Confidence dot */}
            <span
              className="absolute top-2.5 left-3 w-2 h-2 rounded-full"
              style={{
                background: getConfidenceColor(
                  selectedFunction.analysisConfidence
                ),
              }}
              title={`Confidence: ${selectedFunction.analysisConfidence}`}
            />

            {/* Function name */}
            <div
              className="text-base font-bold mb-1"
              style={{
                color: "#e6edf3",
                fontFamily: "var(--font-geist-mono), monospace",
              }}
            >
              {selectedFunction.name}
            </div>

            {/* File */}
            <div className="text-xs mb-2" style={{ color: "#8b949e" }}>
              {shortFile}
            </div>

            {/* Line range */}
            <div className="text-[11px] mb-1" style={{ color: "#484f58" }}>
              Lines {selectedFunction.startLine}–{selectedFunction.endLine}
            </div>

            {/* Badges */}
            <div className="flex items-center justify-center gap-1.5 mt-2">
              {selectedFunction.isExported && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    background: "rgba(56,139,253,0.15)",
                    color: "#58a6ff",
                  }}
                >
                  exported
                </span>
              )}
              {selectedFunction.visibility && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    background: "rgba(139,148,158,0.15)",
                    color: "#8b949e",
                  }}
                >
                  {selectedFunction.visibility}
                </span>
              )}
            </div>
          </div>

          {/* GitHub link */}
          <a
            id="function-github-link"
            href={githubLineLink}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-colors hover:opacity-90"
            style={{
              background: "#1c2128",
              border: "1px solid #30363d",
              color: "#e6edf3",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            Open in GitHub
            <span style={{ color: "#484f58" }}>
              L{selectedFunction.startLine}–L{selectedFunction.endLine}
            </span>
          </a>

          {callees.length > 0 && (
            <div className="text-xs" style={{ color: "#484f58" }}>
              this calls →
            </div>
          )}
        </div>

        {/* ── RIGHT: Callees ────────────────────────────────────────────── */}
        <div className="space-y-3">
          <div
            className="text-xs font-semibold uppercase tracking-wider mb-3 flex items-center gap-2"
            style={{ color: "#58a6ff" }}
          >
            Callees ({callees.length})
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </div>

          {callees.length === 0 ? (
            <EmptyState>Does not call any tracked functions</EmptyState>
          ) : (
            callees.map((fn) => (
              <FunctionCard
                key={fn.id}
                fn={fn}
                borderColor="#58a6ff"
                onClick={() => onFunctionNavigate(fn)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FunctionCard({
  fn,
  borderColor,
  onClick,
}: {
  fn: FunctionNodeDTO;
  borderColor: string;
  onClick: () => void;
}) {
  const shortFile =
    fn.filePath.split("/").pop() || fn.filePath;

  return (
    <button
      className="w-full text-left rounded-xl p-3 transition-all hover:scale-[1.02]"
      style={{
        background: "#161b22",
        border: `1px solid ${borderColor}`,
        borderLeftWidth: "3px",
      }}
      onClick={onClick}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <span
          className="text-sm font-semibold truncate"
          style={{
            color: "#e6edf3",
            fontFamily: "var(--font-geist-mono), monospace",
          }}
        >
          {fn.name}
        </span>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0"
          style={{
            background: `${borderColor}22`,
            color: borderColor,
          }}
        >
          {getKindBadge(fn.kind)}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[11px] truncate" style={{ color: "#8b949e" }}>
          {shortFile}
        </span>
        <span className="text-[10px]" style={{ color: "#484f58" }}>
          L{fn.startLine}–{fn.endLine}
        </span>

        {/* Confidence dot */}
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0 ml-auto"
          style={{
            background: getConfidenceColor(fn.analysisConfidence),
          }}
          title={`Confidence: ${fn.analysisConfidence}`}
        />

        {fn.isExported && (
          <span
            className="text-[9px] px-1 py-0.5 rounded shrink-0"
            style={{
              background: "rgba(56,139,253,0.15)",
              color: "#58a6ff",
            }}
          >
            exp
          </span>
        )}
      </div>
    </button>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl p-4 text-center text-sm italic"
      style={{
        background: "#161b22",
        border: "1px dashed #30363d",
        color: "#484f58",
      }}
    >
      {children}
    </div>
  );
}

function getConfidenceColor(confidence: string): string {
  switch (confidence) {
    case "high":
      return "#3fb950";
    case "medium":
      return "#d29922";
    case "low":
      return "#f85149";
    default:
      return "#484f58";
  }
}
