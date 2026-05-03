"use client";

import { useRef, useEffect, useMemo } from "react";
import type { FileNodeDTO, ImportEdgeDTO, IssueMapResult, AffectedFile } from "../lib/types";
import IssueMapper from "./IssueMapper";

interface SidebarProps {
  // Sizing
  width: number;
  collapsed: boolean;
  onWidthChange: (w: number) => void;
  onCollapsedChange: (c: boolean) => void;
  // Data
  files: FileNodeDTO[];
  edges: ImportEdgeDTO[];
  owner: string;
  repo: string;
  commitSha: string;
  // Issue mapping
  issueResult: IssueMapResult | null;
  isIssueLoading: boolean;
  issueError: string | null;
  onIssueResult: (r: IssueMapResult) => void;
  onIssueClear: () => void;
  setIssueLoading: (v: boolean) => void;
  setIssueError: (v: string | null) => void;
  // Actions
  onFileSelect: (file: FileNodeDTO) => void;
  onZoomToNode: (fileId: string) => void;
  allFunctions: Array<{ id: string; name: string; filePath: string }>;
}

export default function Sidebar({
  width,
  collapsed,
  onWidthChange,
  onCollapsedChange,
  files,
  edges,
  owner,
  repo,
  commitSha,
  issueResult,
  isIssueLoading,
  issueError,
  onIssueResult,
  onIssueClear,
  setIssueLoading,
  setIssueError,
  onFileSelect,
  onZoomToNode,
  allFunctions,
}: SidebarProps) {
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(280);

  // ── Drag resize ───────────────────────────────────────────────────────────
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const diff = ev.clientX - startX.current;
      const newW = Math.max(200, Math.min(480, startW.current + diff));
      onWidthChange(newW);
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      try { localStorage.setItem("codemap-sidebar-width", String(width)); } catch {}
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  // ── Persist width on change ───────────────────────────────────────────────
  useEffect(() => {
    try { localStorage.setItem("codemap-sidebar-width", String(width)); } catch {}
  }, [width]);

  // ── Derived data ──────────────────────────────────────────────────────────
  const entryPoints = useMemo(
    () => files.filter(f => f.isEntryPoint).slice(0, 10),
    [files]
  );

  const mostConnected = useMemo(() => {
    const degreeMap = new Map<string, number>();
    for (const e of edges) {
      degreeMap.set(e.source, (degreeMap.get(e.source) || 0) + 1);
      degreeMap.set(e.target, (degreeMap.get(e.target) || 0) + 1);
    }
    return [...degreeMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id, degree]) => ({ file: files.find(f => f.id === id), degree }))
      .filter(x => x.file) as Array<{ file: FileNodeDTO; degree: number }>;
  }, [files, edges]);

  const affectedFiles: AffectedFile[] = issueResult?.affectedFiles ?? [];

  if (collapsed) {
    return (
      <>
        <div
          className="shrink-0 flex flex-col items-center py-3 gap-3"
          style={{
            width: "40px",
            background: "#0d1117",
            borderRight: "1px solid #21262d",
          }}
        >
          {/* Expand button */}
          <button
            onClick={() => onCollapsedChange(false)}
            className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors"
            style={{ background: "#161b22", border: "1px solid #30363d", color: "#8b949e" }}
            title="Expand sidebar"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
          {/* Issue indicator */}
          {issueResult && (
            <div
              className="w-3 h-3 rounded-full"
              style={{ background: "#f97316" }}
              title={`Issue #${issueResult.issueNumber}`}
            />
          )}
          {/* File count */}
          <span className="text-[9px] font-mono" style={{ color: "#484f58", writingMode: "vertical-rl" }}>
            {files.length} files
          </span>
        </div>
        <div className="resize-handle" onMouseDown={handleMouseDown} />
      </>
    );
  }

  return (
    <>
      <div
        className="shrink-0 flex flex-col overflow-hidden"
        style={{
          width: `${width}px`,
          background: "#0d1117",
          borderRight: "1px solid #21262d",
        }}
      >
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {/* Header with collapse button */}
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#8b949e" }}>EXPLORER</span>
            <button
              onClick={() => onCollapsedChange(true)}
              className="w-6 h-6 rounded flex items-center justify-center transition-colors hover:text-white"
              style={{ background: "transparent", color: "#8b949e" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#21262d"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              title="Collapse sidebar"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          </div>

          {/* ── Issue Mapper Input ──────────────────────────────────────── */}
          <IssueMapper
            owner={owner}
            repo={repo}
            commitSha={commitSha}
            files={files}
            functions={allFunctions as any}
            onResult={onIssueResult}
            onClear={onIssueClear}
            issueResult={issueResult}
            isLoading={isIssueLoading}
            error={issueError}
            setLoading={setIssueLoading}
            setError={setIssueError}
          />

          {/* ── Issue Mapped: Affected Files ───────────────────────────── */}
          {issueResult ? (
            <>
              {/* Issue banner */}
              <div
                className="rounded-xl p-3 space-y-2"
                style={{ background: "rgba(249,115,22,0.06)", border: "1px solid rgba(249,115,22,0.2)" }}
              >
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#f97316" }} />
                  <span className="text-xs font-semibold truncate flex-1" style={{ color: "#e6edf3" }}>
                    #{issueResult.issueNumber}: {issueResult.issueTitle}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(249,115,22,0.15)", color: "#f97316" }}>
                    {affectedFiles.length} file{affectedFiles.length !== 1 ? "s" : ""} affected
                  </span>
                  <button
                    onClick={onIssueClear}
                    className="ml-auto text-[10px] px-2 py-0.5 rounded transition-colors"
                    style={{ color: "#8b949e", background: "rgba(255,255,255,0.05)", border: "1px solid #30363d" }}
                  >
                    Clear
                  </button>
                </div>
              </div>

              {/* Affected files list */}
              <div className="space-y-1">
                <div className="text-[10px] font-semibold uppercase tracking-wider px-1" style={{ color: "#8b949e" }}>
                  Affected Files
                </div>
                {affectedFiles.map(af => {
                  const file = files.find(f => f.id === af.fileId);
                  const parts = af.fileId.split("/");
                  const filename = parts.pop() || af.fileId;
                  const folder = parts.join("/");
                  return (
                    <button
                      key={af.fileId}
                      className="w-full text-left px-2 py-2 rounded-lg transition-colors"
                      style={{ background: "transparent" }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#161b22"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                      onClick={() => {
                        onZoomToNode(af.fileId);
                        if (file) onFileSelect(file);
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold truncate flex-1" style={{ color: "#e6edf3", fontFamily: "var(--font-geist-mono), monospace" }}>
                          {filename}
                        </span>
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded font-bold shrink-0"
                          style={{
                            background: af.confidence >= 80 ? "rgba(34,197,94,0.15)" : af.confidence >= 50 ? "rgba(249,115,22,0.15)" : "rgba(139,148,158,0.15)",
                            color: af.confidence >= 80 ? "#22c55e" : af.confidence >= 50 ? "#f97316" : "#8b949e",
                          }}
                        >
                          {af.confidence}%
                        </span>
                      </div>
                      {folder && (
                        <div className="text-[10px] mt-0.5 truncate" style={{ color: "#484f58" }}>
                          {folder}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              {/* ── Quick Start ───────────────────────────────────────────── */}
              <div className="rounded-xl p-3" style={{ background: "#161b22", border: "1px solid #21262d" }}>
                <div className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: "#8b949e" }}>
                  Quick Start
                </div>
                <ul className="space-y-1.5 text-[11px]" style={{ color: "#8b949e" }}>
                  <li className="flex items-start gap-2">
                    <span style={{ color: "#58a6ff" }}>•</span>
                    <span>Click any node to see file details</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span style={{ color: "#58a6ff" }}>•</span>
                    <span>Click a function to see its call graph</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span style={{ color: "#58a6ff" }}>•</span>
                    <span>Hover nodes to highlight connections</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span style={{ color: "#f97316" }}>•</span>
                    <span>Map an issue above to find affected files</span>
                  </li>
                </ul>
              </div>

              {/* ── Entry Points ──────────────────────────────────────────── */}
              {entryPoints.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider mb-1.5 px-1" style={{ color: "#8b949e" }}>
                    ⚡ Entry Points ({entryPoints.length})
                  </div>
                  <div className="space-y-0.5">
                    {entryPoints.map(f => (
                      <button
                        key={f.id}
                        onClick={() => { onFileSelect(f); onZoomToNode(f.id); }}
                        className="w-full text-left px-2 py-1.5 rounded-lg text-[11px] truncate transition-colors"
                        style={{ color: "#3fb950", fontFamily: "var(--font-geist-mono), monospace" }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#161b22"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Most Connected ────────────────────────────────────────── */}
              {mostConnected.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider mb-1.5 px-1" style={{ color: "#8b949e" }}>
                    🔗 Most Connected
                  </div>
                  <div className="space-y-0.5">
                    {mostConnected.map(({ file, degree }) => (
                      <button
                        key={file.id}
                        onClick={() => { onFileSelect(file); onZoomToNode(file.id); }}
                        className="w-full text-left px-2 py-1.5 rounded-lg text-[11px] truncate transition-colors flex items-center gap-2"
                        style={{ color: "#e6edf3", fontFamily: "var(--font-geist-mono), monospace" }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#161b22"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                      >
                        <span className="truncate flex-1">{file.label}</span>
                        <span className="text-[9px] shrink-0" style={{ color: "#484f58" }}>{degree} edges</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Resize handle */}
      <div className="resize-handle" onMouseDown={handleMouseDown} />
    </>
  );
}
