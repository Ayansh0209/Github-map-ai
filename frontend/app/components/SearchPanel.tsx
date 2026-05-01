"use client";

// SearchPanel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Sidebar overlay search panel for code intelligence.
// Opens as a slide-in overlay from the right side of the graph view.
// Supports searching files, exports, tests, and issue mapping.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useCallback, useRef, useEffect } from "react";
import { searchCode } from "../lib/client";
import type { SearchResultItem } from "../lib/types";

interface SearchPanelProps {
  isOpen: boolean;
  onClose: () => void;
  owner: string;
  repo: string;
  onSelectFile?: (filePath: string) => void;
}

type SearchTab = "all" | "file" | "export" | "test";

export default function SearchPanel({
  isOpen,
  onClose,
  owner,
  repo,
  onSelectFile,
}: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<SearchTab>("all");
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalResults, setTotalResults] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen]);

  // Debounced search
  const performSearch = useCallback(
    async (q: string, tab: SearchTab) => {
      if (q.length < 2) {
        setResults([]);
        setTotalResults(0);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const type = tab === "all" ? undefined : tab;
        const data = await searchCode(owner, repo, q, type, 30);
        setResults(data.results);
        setTotalResults(data.total);
      } catch (err) {
        setError((err as Error).message);
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [owner, repo],
  );

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => performSearch(value, activeTab), 300);
  };

  const handleTabChange = (tab: SearchTab) => {
    setActiveTab(tab);
    if (query.length >= 2) performSearch(query, tab);
  };

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "file":     return "📄";
      case "export":   return "ƒ";
      case "test":     return "🧪";
      default:         return "•";
    }
  };

  const getKindBadgeColor = (kind?: string) => {
    switch (kind) {
      case "test":     return { bg: "rgba(34,197,94,0.15)", color: "#22c55e" };
      case "config":   return { bg: "rgba(107,114,128,0.15)", color: "#9ca3af" };
      case "ui":       return { bg: "rgba(124,58,237,0.15)", color: "#a78bfa" };
      default:         return { bg: "rgba(56,189,248,0.15)", color: "#38bdf8" };
    }
  };

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40"
          style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(2px)" }}
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        className="fixed top-0 right-0 h-full z-50 flex flex-col"
        style={{
          width: "420px",
          maxWidth: "90vw",
          background: "#0d1117",
          borderLeft: "1px solid #30363d",
          transform: isOpen ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)",
          boxShadow: isOpen ? "-8px 0 32px rgba(0,0,0,0.5)" : "none",
        }}
      >
        {/* Header */}
        <div className="px-4 py-3 flex items-center gap-3"
          style={{ borderBottom: "1px solid #30363d" }}>
          <span style={{ fontSize: "16px" }}>🔍</span>
          <span className="font-semibold text-sm" style={{ color: "#e6edf3" }}>
            Search Code
          </span>
          <span className="text-xs ml-auto" style={{ color: "#8b949e" }}>
            {owner}/{repo}
          </span>
          <button
            onClick={onClose}
            className="ml-2 w-6 h-6 flex items-center justify-center rounded hover:bg-white/10"
            style={{ color: "#8b949e", fontSize: "14px" }}
          >
            ✕
          </button>
        </div>

        {/* Search input */}
        <div className="px-4 py-3">
          <input
            ref={inputRef}
            type="text"
            placeholder="Search files, functions, exports..."
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            className="w-full px-3 py-2 rounded-lg text-sm outline-none"
            style={{
              background: "#161b22",
              border: "1px solid #30363d",
              color: "#e6edf3",
              fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            }}
          />
        </div>

        {/* Tabs */}
        <div className="px-4 flex gap-1" style={{ borderBottom: "1px solid #21262d" }}>
          {(["all", "file", "export", "test"] as SearchTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => handleTabChange(tab)}
              className="px-3 py-1.5 text-xs font-medium rounded-t transition-colors"
              style={{
                color: activeTab === tab ? "#e6edf3" : "#8b949e",
                background: activeTab === tab ? "#161b22" : "transparent",
                borderBottom: activeTab === tab ? "2px solid #58a6ff" : "2px solid transparent",
              }}
            >
              {tab === "all" ? "All" : tab === "file" ? "Files" : tab === "export" ? "Exports" : "Tests"}
            </button>
          ))}
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full" />
              <span className="ml-2 text-xs" style={{ color: "#8b949e" }}>Searching...</span>
            </div>
          )}

          {error && (
            <div className="text-xs px-3 py-2 rounded-lg"
              style={{ background: "rgba(248,81,73,0.1)", color: "#f85149" }}>
              {error}
            </div>
          )}

          {!loading && !error && results.length === 0 && query.length >= 2 && (
            <div className="text-xs text-center py-8" style={{ color: "#8b949e" }}>
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {!loading && results.map((result, i) => {
            const badgeColor = getKindBadgeColor(result.kind);
            return (
              <button
                key={`${result.id}-${i}`}
                onClick={() => onSelectFile?.(result.filePath)}
                className="w-full text-left px-3 py-2.5 rounded-lg transition-colors group"
                style={{
                  background: "transparent",
                  border: "1px solid transparent",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "#161b22";
                  e.currentTarget.style.borderColor = "#30363d";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.borderColor = "transparent";
                }}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm">{getTypeIcon(result.type)}</span>
                  <span className="text-sm font-medium truncate"
                    style={{ color: "#e6edf3", fontFamily: "var(--font-geist-mono), monospace" }}>
                    {result.name}
                  </span>
                  {result.kind && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] ml-auto flex-shrink-0"
                      style={{ background: badgeColor.bg, color: badgeColor.color }}>
                      {result.kind}
                    </span>
                  )}
                  {result.isDeadCode && (
                    <span className="px-1 py-0.5 rounded text-[10px]"
                      style={{ background: "rgba(248,81,73,0.12)", color: "#f85149" }}>
                      dead
                    </span>
                  )}
                  {result.isEntryPoint && (
                    <span className="px-1 py-0.5 rounded text-[10px]"
                      style={{ background: "rgba(34,197,94,0.12)", color: "#22c55e" }}>
                      entry
                    </span>
                  )}
                </div>
                <div className="text-[11px] truncate" style={{ color: "#8b949e" }}>
                  {result.filePath}
                </div>
                {result.packageName && (
                  <div className="text-[10px] mt-0.5" style={{ color: "#6e7681" }}>
                    📦 {result.packageName}
                  </div>
                )}
                <div className="text-[10px] mt-0.5 flex items-center gap-2">
                  <span style={{ color: "#6e7681" }}>
                    match: {result.score}%
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        {/* Footer */}
        {totalResults > 0 && (
          <div className="px-4 py-2 text-xs flex items-center justify-between"
            style={{ borderTop: "1px solid #21262d", color: "#8b949e" }}>
            <span>{totalResults} results</span>
            <span>⌘K to search</span>
          </div>
        )}
      </div>
    </>
  );
}
