"use client";

import type { ViewMode } from "../lib/types";
import FiltersDropdown from "./FiltersDropdown";

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
  focusMode?: boolean;
  onFocusModeToggle?: () => void;
  hasIssueResult?: boolean;
  activeKinds: Set<string>;
  activeLanguages: Set<string>;
  onKindsChange: (kinds: Set<string>) => void;
  onLanguagesChange: (langs: Set<string>) => void;
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
  focusMode = false,
  onFocusModeToggle,
  hasIssueResult = false,
  activeKinds,
  activeLanguages,
  onKindsChange,
  onLanguagesChange,
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
        minHeight: "54px",
      }}
    >
      {/* View Toggle */}
      <div className="flex rounded-lg overflow-hidden shrink-0" style={{ border: "1px solid #30363d", height: "32px" }}>
        <button
          id="view-file-graph-btn"
          onClick={() => onViewChange("file-graph")}
          className="px-3 flex items-center justify-center text-xs font-medium transition-colors"
          style={{
            background: view === "file-graph" ? "#1f6feb" : "#161b22",
            color: view === "file-graph" ? "#fff" : "#8b949e",
          }}
        >
          File Graph
        </button>
        <button
          onClick={() => hasFunctionSelected && onViewChange("function-graph")}
          disabled={!hasFunctionSelected}
          className="px-3 flex items-center justify-center text-xs font-medium transition-colors"
          style={{
            background: view === "function-graph" ? "#1f6feb" : "#161b22",
            color: view === "function-graph" ? "#fff" : hasFunctionSelected ? "#8b949e" : "#484f58",
            cursor: hasFunctionSelected ? "pointer" : "not-allowed",
            borderLeft: "1px solid #30363d",
          }}
          title={hasFunctionSelected ? "Switch to Function Graph" : "Select a function first"}
        >
          Function Graph
        </button>
      </div>

      {/* Reset View Button */}
      <button
        onClick={onResetView}
        className="px-3 rounded-lg flex items-center justify-center text-xs font-medium transition-colors border shrink-0 hover:bg-[#21262d]"
        style={{
          background: "#161b22",
          color: "#8b949e",
          border: "1px solid #30363d",
          height: "32px",
        }}
        title="Reset zoom & clear search"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-1.5">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </svg>
        Reset View
      </button>

      {/* Focus Mode Toggle */}
      {hasIssueResult && onFocusModeToggle && (
        <button
          onClick={onFocusModeToggle}
          className="px-3 rounded-lg flex items-center justify-center text-xs font-medium transition-colors border shrink-0 hover:opacity-80"
          style={{
            background: focusMode ? "rgba(249,115,22,0.15)" : "#161b22",
            color: focusMode ? "#f97316" : "#8b949e",
            border: focusMode ? "1px solid rgba(249,115,22,0.4)" : "1px solid #30363d",
            height: "32px",
          }}
        >
          {focusMode ? "Show all files" : "Focus on affected"}
        </button>
      )}

      {/* Vertical separator */}
      <div className="hidden sm:block w-px h-5 mx-1" style={{ background: "#30363d" }} />

      {/* Search Input */}
      <div className="relative flex-1 min-w-[150px]">
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
          className="w-full pl-9 pr-8 rounded-lg text-sm outline-none transition-colors focus:border-[#58a6ff]"
          style={{
            background: "#161b22",
            border: "1px solid #30363d",
            color: "#e6edf3",
            fontFamily: "var(--font-geist-mono), monospace",
            fontSize: "12px",
            height: "32px",
          }}
          autoComplete="off"
          spellCheck={false}
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 hover:text-[#e6edf3] transition-colors"
            style={{ color: "#484f58", fontSize: "14px", height: "20px", width: "20px", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Filters Dropdown */}
      <div className="shrink-0">
        <FiltersDropdown
          activeKinds={activeKinds}
          activeLanguages={activeLanguages}
          onKindsChange={onKindsChange}
          onLanguagesChange={onLanguagesChange}
        />
      </div>

      {/* Advanced Search */}
      {onSearchOpen && (
        <button
          onClick={onSearchOpen}
          className="px-3 rounded-lg flex items-center justify-center text-xs font-medium transition-colors border shrink-0 hover:opacity-80"
          style={{
            background: "#161b22",
            color: "#58a6ff",
            border: "1px solid #30363d",
            height: "32px",
          }}
        >
          <span className="mr-1.5">🔍</span>
          <span>Search</span>
          <span className="text-[10px] px-1 rounded ml-1.5" style={{ background: "rgba(88,166,255,0.12)" }}>⌘K</span>
        </button>
      )}

      {/* Stats */}
      <span className="text-xs ml-auto shrink-0" style={{ color: "#484f58" }}>
        {fileCount} files · {edgeCount} edges
      </span>
    </div>
  );
}
