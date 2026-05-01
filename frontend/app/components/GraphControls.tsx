"use client";

import type { ViewMode } from "../lib/types";

interface GraphControlsProps {
  view: ViewMode;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onViewChange: (view: ViewMode) => void;
  onResetView: () => void;
  onSearchOpen?: () => void;
  fileCount: number;
  edgeCount: number;
  hasFunctionSelected: boolean;
}

export default function GraphControls({
  view,
  searchQuery,
  onSearchChange,
  onViewChange,
  onResetView,
  onSearchOpen,
  fileCount,
  edgeCount,
  hasFunctionSelected,
}: GraphControlsProps) {
  return (
    <div
      className="flex items-center gap-3 flex-wrap"
      style={{
        padding: "10px 16px",
        background: "rgba(13,17,23,0.95)",
        border: "1px solid #30363d",
        borderRadius: "12px",
        marginBottom: "12px",
      }}
    >
      {/* Search */}
      {/* <div className="relative flex-1 min-w-[200px] max-w-[320px]">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#484f58"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          id="graph-search-input"
          type="text"
          placeholder="Search files..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full pl-9 pr-3 py-1.5 rounded-lg text-sm outline-none"
          style={{
            background: "#161b22",
            border: "1px solid #30363d",
            color: "#e6edf3",
            fontFamily: "var(--font-geist-mono), monospace",
            fontSize: "12px",
          }}
          autoComplete="off"
          spellCheck={false}
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 hover:opacity-80"
            style={{ color: "#484f58", fontSize: "14px" }}
          >
            ✕
          </button>
        )}
      </div> */}

      {/* View toggle */}
      <div className="flex flex-col gap-1">
        <div
          className="flex rounded-lg overflow-hidden"
          style={{ border: "1px solid #30363d" }}
        >
          <button
            id="view-file-graph-btn"
            onClick={() => onViewChange("file-graph")}
            className="px-3 py-1.5 text-xs font-medium transition-colors"
            style={{
              background: view === "file-graph" ? "#1f6feb" : "#161b22",
              color: view === "file-graph" ? "#fff" : "#8b949e",
            }}
          >
            File Graph
          </button>
          <button
            id="view-function-graph-btn"
            onClick={() => hasFunctionSelected && onViewChange("function-graph")}
            className="px-3 py-1.5 text-xs font-medium transition-colors"
            style={{
              background:
                view === "function-graph" ? "#1f6feb" : "#161b22",
              color: view === "function-graph" ? "#fff" : hasFunctionSelected ? "#8b949e" : "#484f58",
              cursor: hasFunctionSelected ? "pointer" : "not-allowed",
            }}
            title={
              hasFunctionSelected
                ? "Switch to function graph"
                : "Click a file → then click a function in the panel to activate"
            }
          >
            Function Graph
          </button>
        </div>
        {!hasFunctionSelected && (
          <span className="text-[10px] pl-1" style={{ color: "#484f58" }}>
            ↑ Click a file → click a function to unlock
          </span>
        )}
      </div>

      {/* Reset */}
      <button
        id="reset-view-btn"
        onClick={onResetView}
        className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:opacity-80"
        style={{
          background: "#161b22",
          border: "1px solid #30363d",
          color: "#8b949e",
        }}
      >
        Reset View
      </button>

      {/* Advanced Search */}
      {onSearchOpen && (
        <button
          id="advanced-search-btn"
          onClick={onSearchOpen}
          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:opacity-80 flex items-center gap-1.5"
          style={{
            background: "#161b22",
            border: "1px solid #30363d",
            color: "#58a6ff",
          }}
        >
          <span>🔍</span>
          <span>Search</span>
          <span className="text-[10px] px-1 rounded" style={{ background: "rgba(88,166,255,0.12)", color: "#58a6ff" }}>⌘K</span>
        </button>
      )}

      {/* Stats */}
      <span className="text-xs ml-auto" style={{ color: "#484f58" }}>
        {fileCount} files · {edgeCount} edges
      </span>
    </div>
  );
}
