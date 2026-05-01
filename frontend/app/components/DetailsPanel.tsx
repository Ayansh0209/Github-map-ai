"use client";

import type {
  FileNodeDTO,
  ImportEdgeDTO,
  FunctionNodeDTO,
  FunctionFilePayload,
} from "../lib/types";
import {
  makeGitHubFileLink,
  getKindBadge,
  sanitizeFileId,
} from "../lib/graphHelpers";

interface DetailsPanelProps {
  file: FileNodeDTO | null;
  edges: ImportEdgeDTO[];
  owner: string;
  repo: string;
  commitSha: string;
  functionFiles: Record<string, FunctionFilePayload> | null;
  onClose: () => void;
  onFileNavigate: (fileId: string) => void;
  onFunctionClick: (fn: FunctionNodeDTO) => void;
}

export default function DetailsPanel({
  file,
  edges,
  owner,
  repo,
  commitSha,
  functionFiles,
  onClose,
  onFileNavigate,
  onFunctionClick,
}: DetailsPanelProps) {
  if (!file) return null;

  // imports FROM this file (outgoing)
  const outgoing = edges.filter((e) => e.source === file.id);
  // imports INTO this file (incoming)
  const incoming = edges.filter((e) => e.target === file.id);

  const githubUrl = makeGitHubFileLink(owner, repo, commitSha, file.path);

  // ── Functions for this file ─────────────────────────────────────────────
  const sanitizedId = sanitizeFileId(file.id);
  const functionData = functionFiles?.[sanitizedId] ?? null;
  const functions = functionData?.functions ?? [];

  return (
    <div
      className="fixed right-0 top-0 h-full z-40 overflow-y-auto shadow-2xl"
      style={{
        width: "340px",
        background: "#161b22",
        borderLeft: "1px solid #30363d",
      }}
    >
      {/* Header */}
      <div
        className="sticky top-0 backdrop-blur p-4 flex items-start justify-between gap-3"
        style={{
          background: "rgba(22,27,34,0.95)",
          borderBottom: "1px solid #30363d",
        }}
      >
        <div className="min-w-0">
          <h3
            className="text-sm font-semibold truncate"
            style={{
              color: "#e6edf3",
              fontFamily: "var(--font-geist-mono), monospace",
            }}
          >
            {file.label}
          </h3>
          <p
            className="text-xs mt-0.5 truncate"
            style={{ color: "#8b949e" }}
          >
            {file.path}
          </p>
        </div>
        <button
          id="details-close-btn"
          onClick={onClose}
          className="p-1 rounded-lg transition-colors shrink-0 hover:opacity-80"
          style={{ color: "#8b949e" }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="p-4 space-y-5">
        {/* File info */}
        <section>
          <SectionHeader>File Info</SectionHeader>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <InfoRow label="Language" value={file.language} />
            <InfoRow label="Kind" value={file.kind} />
            <InfoRow label="Lines" value={file.lineCount.toString()} />
            <InfoRow
              label="Size"
              value={`${(file.sizeBytes / 1024).toFixed(1)}KB`}
            />
            <InfoRow label="Status" value={file.parseStatus} />
            <InfoRow
              label="Entry Point"
              value={file.isEntryPoint ? "Yes" : "No"}
            />
            {file.entryScore !== undefined && (
              <InfoRow label="Entry Score" value={file.entryScore.toString()} />
            )}
            {file.cycleScore !== undefined && file.cycleScore > 0 && (
              <InfoRow label="Cycle" value="⚠ Circular Dep" />
            )}
            {file.hubScore !== undefined && file.hubScore > 0 && (
              <InfoRow label="Hub Score" value={file.hubScore.toString()} />
            )}
            {file.architecturalImportance !== undefined && file.architecturalImportance > 0 && (
              <InfoRow label="Arch Weight" value={file.architecturalImportance.toString()} />
            )}
            {file.workspacePackage && (
              <InfoRow label="Package" value={file.workspacePackage} />
            )}
          </div>
          {/* Subtle dead code indicator — only shown when file has meaningful dead score */}
          {file.isDeadCode && (
            <div className="mt-2 rounded-lg px-3 py-2 text-xs flex items-center gap-2"
              style={{ background: "rgba(248,81,73,0.08)", border: "1px dashed rgba(248,81,73,0.3)" }}>
              <span style={{ opacity: 0.7 }}>💀</span>
              <span style={{ color: "#f85149", fontWeight: 600 }}>Potential dead code</span>
              <span style={{ color: "#8b949e", marginLeft: "auto" }}>score: {file.deadCodeScore ?? 0}</span>
            </div>
          )}
          {/* Unused exports — subtle list */}
          {file.unusedExports && file.unusedExports.length > 0 && (
            <div className="mt-2 rounded-lg px-3 py-2 text-xs"
              style={{ background: "rgba(240,136,62,0.06)", border: "1px dashed rgba(240,136,62,0.25)" }}>
              <div style={{ color: "#f0883e", fontWeight: 600, marginBottom: "4px" }}>
                Unused Exports ({file.unusedExports.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {file.unusedExports.map((exp, i) => (
                  <span key={i} className="px-1.5 py-0.5 rounded text-[10px]"
                    style={{ background: "rgba(240,136,62,0.12)", color: "#f0883e",
                      fontFamily: "var(--font-geist-mono), monospace" }}>
                    {exp}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* ── ENTRY REASONS ───────────────────────────────────────────────── */}
        {file.entryReasons && file.entryReasons.length > 0 && (
          <section>
            <SectionHeader>Entry Scoring Reasons</SectionHeader>
            <div className="rounded-lg p-3 text-xs space-y-1" style={{ background: "#0d1117", border: "1px solid #30363d" }}>
              <ul className="list-disc list-inside space-y-1">
                {[...file.entryReasons]
                  .sort((a, b) => {
                    const matchA = a.match(/^([+-]?\d+)/);
                    const matchB = b.match(/^([+-]?\d+)/);
                    const valA = matchA ? Math.abs(parseInt(matchA[1], 10)) : 0;
                    const valB = matchB ? Math.abs(parseInt(matchB[1], 10)) : 0;
                    return valB - valA;
                  })
                  .map((reason, i) => (
                  <li key={i} style={{ color: reason.includes("-") ? "#f85149" : "#3fb950" }}>
                    <span style={{ color: "#c9d1d9" }}>{reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}

        {/* ── TEST INTELLIGENCE ───────────────────────────────────────────── */}
        {file.kind === "test" && (
          <section>
            <SectionHeader>Test Intelligence</SectionHeader>
            <div className="rounded-lg p-3 text-xs space-y-3" style={{ background: "#0d1117", border: "1px dashed #3fb950" }}>
              <div className="flex gap-4">
                <div>
                  <span style={{ color: "#8b949e", fontWeight: 600 }}>TEST SUITES </span>
                  <span style={{ color: "#e6edf3", fontWeight: 700 }}>({file.testSuites?.length || 0})</span>
                </div>
                <div>
                  <span style={{ color: "#8b949e", fontWeight: 600 }}>TEST CASES </span>
                  <span style={{ color: "#e6edf3", fontWeight: 700 }}>({file.testCases?.length || 0})</span>
                </div>
              </div>

              {outgoing.filter(e => e.isTestCoverage).length > 0 && (
                <div>
                  <div style={{ color: "#8b949e", fontWeight: 600, marginBottom: "4px" }}>COVERS:</div>
                  <ul className="space-y-1">
                    {outgoing.filter(e => e.isTestCoverage).map((e, i) => (
                      <li key={i}>
                        <button
                          className="w-full text-left truncate hover:underline"
                          style={{ color: "#58a6ff", fontFamily: "var(--font-geist-mono), monospace" }}
                          onClick={() => onFileNavigate(e.target)}
                        >
                          {e.target}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── FUNCTIONS ───────────────────────────────────────────────────── */}
        <section>
          <SectionHeader>Functions ({functions.length})</SectionHeader>

          {!functionFiles ? (
            <div className="rounded-lg p-3 text-xs space-y-1" style={{ background: "#0d1117", border: "1px dashed #30363d" }}>
              <div style={{ color: "#f0883e", fontWeight: 600 }}>⚠ Function data not available</div>
              <div style={{ color: "#8b949e" }}>
                Re-analyze the repo to get function-level data. If this is a JavaScript-only repo, function analysis may be limited.
              </div>
            </div>
          ) : file.parseStatus === "imports-only" ? (
            <EmptyMessage>
              Function data unavailable — file was too large for full parse
            </EmptyMessage>
          ) : functions.length === 0 ? (
            <div className="rounded-lg p-3 text-xs space-y-1" style={{ background: "#0d1117", border: "1px dashed #30363d" }}>
              <div style={{ color: "#8b949e" }}>No functions detected in this file.</div>
              <div style={{ color: "#484f58" }}>
                {file.language === "javascript"
                  ? "JavaScript files have limited function analysis. Try a TypeScript repo for full call graphs."
                  : "This file may contain no exported functions, or parsing was skipped."}
              </div>
            </div>
          ) : (
            <div
              className="space-y-1 overflow-y-auto pr-1"
              style={{ maxHeight: "300px" }}
            >
              {functions.map((fn) => (
                <button
                  key={fn.id}
                  className="w-full text-left py-2 px-2.5 rounded-lg transition-colors flex items-center gap-2"
                  style={{
                    background: "transparent",
                    color: "#e6edf3",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "#1c2128";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "transparent";
                  }}
                  onClick={() => onFunctionClick(fn)}
                >
                  {/* Name */}
                  <span
                    className="text-sm font-semibold truncate flex-1"
                    style={{
                      fontFamily: "var(--font-geist-mono), monospace",
                      color: "#e6edf3",
                    }}
                  >
                    {fn.name}
                  </span>

                  {/* Kind badge */}
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0"
                    style={{
                      background: getKindBadgeColor(fn.kind),
                      color: "#e6edf3",
                    }}
                  >
                    {fn.name.startsWith("describe") ? "suite" : (fn.name.startsWith("it") || fn.name.startsWith("test(")) ? "test case" : getKindBadge(fn.kind)}
                  </span>

                  {/* Line range */}
                  <span
                    className="text-[10px] shrink-0"
                    style={{ color: "#484f58" }}
                  >
                    L{fn.startLine}-{fn.endLine}
                  </span>

                  {/* Exported badge */}
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
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Imports outgoing */}
        <section>
          <SectionHeader>Imports ({outgoing.length})</SectionHeader>
          {outgoing.length === 0 ? (
            <EmptyMessage>No imports</EmptyMessage>
          ) : (
            <ul className="space-y-1">
              {outgoing.map((e, i) => (
                <li key={i}>
                  <button
                    className="w-full text-left text-sm py-1.5 px-2 rounded-lg transition-colors flex items-center gap-2"
                    style={{ color: "#e6edf3" }}
                    onMouseEnter={(ev) => {
                      (ev.currentTarget as HTMLElement).style.background = "#1c2128";
                    }}
                    onMouseLeave={(ev) => {
                      (ev.currentTarget as HTMLElement).style.background = "transparent";
                    }}
                    onClick={() => onFileNavigate(e.target)}
                  >
                    <span style={{ color: "#58a6ff" }}>→</span>
                    <span
                      className="text-xs truncate"
                      style={{ fontFamily: "var(--font-geist-mono), monospace" }}
                    >
                      {e.target}
                    </span>
                    {e.symbols.length > 0 && (
                      <span
                        className="text-[10px] shrink-0"
                        style={{ color: "#484f58" }}
                      >
                        {e.symbols.length} symbols
                      </span>
                    )}
                    {e.isTypeOnly && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                        style={{
                          background: "rgba(6,182,212,0.1)",
                          color: "#22d3ee",
                        }}
                      >
                        type
                      </span>
                    )}
                    {e.isCircular && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                        style={{ background: "rgba(248,81,73,0.1)", color: "#f85149" }}
                      >
                        cycle
                      </span>
                    )}
                    {e.isTestCoverage && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                        style={{ background: "rgba(34,197,94,0.1)", color: "#22c55e" }}
                      >
                        test
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Imported by */}
        <section>
          <SectionHeader>Imported By ({incoming.length})</SectionHeader>
          {incoming.length === 0 ? (
            <EmptyMessage>Not imported by any file</EmptyMessage>
          ) : (
            <ul className="space-y-1">
              {incoming.map((e, i) => (
                <li key={i}>
                  <button
                    className="w-full text-left text-sm py-1.5 px-2 rounded-lg transition-colors flex items-center gap-2"
                    style={{ color: "#e6edf3" }}
                    onMouseEnter={(ev) => {
                      (ev.currentTarget as HTMLElement).style.background = "#1c2128";
                    }}
                    onMouseLeave={(ev) => {
                      (ev.currentTarget as HTMLElement).style.background = "transparent";
                    }}
                    onClick={() => onFileNavigate(e.source)}
                  >
                    <span style={{ color: "#3fb950" }}>←</span>
                    <span
                      className="text-xs truncate"
                      style={{ fontFamily: "var(--font-geist-mono), monospace" }}
                    >
                      {e.source}
                    </span>
                    {e.isCircular && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                        style={{ background: "rgba(248,81,73,0.1)", color: "#f85149" }}
                      >
                        cycle
                      </span>
                    )}
                    {e.isTestCoverage && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                        style={{ background: "rgba(34,197,94,0.1)", color: "#22c55e" }}
                      >
                        test
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* External imports */}
        {file.externalImports.length > 0 && (
          <section>
            <SectionHeader>
              External Deps ({file.externalImports.length})
            </SectionHeader>
            <div className="flex flex-wrap gap-1.5">
              {file.externalImports.map((dep, i) => (
                <span
                  key={i}
                  className="text-xs px-2 py-1 rounded-md"
                  style={{
                    background: "#1c2128",
                    color: "#8b949e",
                    fontFamily: "var(--font-geist-mono), monospace",
                  }}
                >
                  {dep}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* GitHub link */}
        <section>
          <a
            id="github-link"
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-sm font-medium transition-colors hover:opacity-90"
            style={{
              background: "#1c2128",
              border: "1px solid #30363d",
              color: "#e6edf3",
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            View on GitHub
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
            </svg>
          </a>
        </section>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h4
      className="text-xs font-semibold uppercase tracking-wider mb-2"
      style={{ color: "#8b949e" }}
    >
      {children}
    </h4>
  );
}

function EmptyMessage({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm italic" style={{ color: "rgba(139,148,158,0.6)" }}>
      {children}
    </p>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-1.5 px-2 rounded-lg" style={{ background: "#0d1117" }}>
      <div
        className="text-[10px] uppercase tracking-wider"
        style={{ color: "#8b949e" }}
      >
        {label}
      </div>
      <div className="text-sm font-medium mt-0.5" style={{ color: "#e6edf3" }}>
        {value}
      </div>
    </div>
  );
}

function getKindBadgeColor(kind: string): string {
  switch (kind) {
    case "component": return "rgba(6,182,212,0.2)";
    case "hook": return "rgba(244,63,94,0.2)";
    case "reducer": return "rgba(168,85,247,0.2)";
    case "route-handler":
    case "middleware": return "rgba(16,185,129,0.2)";
    case "test": return "rgba(34,197,94,0.2)";
    case "context-provider": return "rgba(59,130,246,0.2)";
    case "callback": return "rgba(139,148,158,0.2)";
    case "async":
      return "rgba(136,46,224,0.25)";
    case "arrow":
      return "rgba(56,139,253,0.2)";
    case "method":
      return "rgba(240,136,62,0.2)";
    case "constructor":
      return "rgba(240,136,62,0.3)";
    case "getter":
    case "setter":
      return "rgba(63,185,80,0.2)";
    default:
      return "rgba(139,148,158,0.15)";
  }
}
