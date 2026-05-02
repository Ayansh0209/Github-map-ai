"use client";

// SearchPanel.tsx
// Sidebar overlay — Search mode only.
// (The old "Diagnose" tab has been replaced by IssueMapper in the main view)
//
// Finds files, exports, and tests across the analyzed repo.
// Panel is resizable.

import { useState, useCallback, useRef, useEffect } from "react";
import { searchCode } from "../lib/client";
import type { SearchResultItem } from "../lib/types";

// ── Types ──────────────────────────────────────────────────────────────────────

interface SearchPanelProps {
  isOpen: boolean;
  onClose: () => void;
  owner: string;
  repo: string;
  onSelectFile?: (filePath: string) => void;
  onSelectFunction?: (functionId: string, filePath: string) => void;
}

type SearchTypeFilter = "all" | "file" | "export" | "test";

// ── Helpers ────────────────────────────────────────────────────────────────────

function ScorePill({ score }: { score: number }) {
  const color = score >= 70 ? "#22c55e" : score >= 40 ? "#f0883e" : "#8b949e";
  return (
    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.06)", color }}>
      {score}%
    </span>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function SearchPanel({
  isOpen,
  onClose,
  owner,
  repo,
  onSelectFile,
  onSelectFunction,
}: SearchPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<SearchTypeFilter>("all");
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Panel width (resizable)
  const [panelWidth, setPanelWidth] = useState(440);
  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(440);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Focus on open
  useEffect(() => {
    if (!isOpen) return;
    setTimeout(() => searchInputRef.current?.focus(), 150);
  }, [isOpen]);

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && isOpen) onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  // ── Resize logic ─────────────────────────────────────────────────────────────

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    resizingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = panelWidth;
    e.preventDefault();
  }, [panelWidth]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = startXRef.current - e.clientX;
      setPanelWidth(Math.min(680, Math.max(360, startWidthRef.current + delta)));
    };
    const onUp = () => { resizingRef.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  // ── Search logic ──────────────────────────────────────────────────────────────

  const performSearch = useCallback(async (q: string, filter: SearchTypeFilter) => {
    if (q.length < 2) { setSearchResults([]); setSearchTotal(0); return; }
    setLoading(true); setError(null);
    try {
      const type = filter === "all" ? undefined : filter as "file" | "export" | "test";
      const data = await searchCode(owner, repo, q, type, 30);
      setSearchResults(data.results); setSearchTotal(data.total);
    } catch (err) { setError((err as Error).message); setSearchResults([]); }
    finally { setLoading(false); }
  }, [owner, repo]);

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => performSearch(val, typeFilter), 300);
  };

  const handleFilterChange = (f: SearchTypeFilter) => {
    setTypeFilter(f);
    if (searchQuery.length >= 2) performSearch(searchQuery, f);
  };

  // ── Type icons ────────────────────────────────────────────────────────────────

  const typeIcon = (type: string) => {
    if (type === "file")   return <span style={{ color: "#79c0ff", fontSize: 13 }}>📄</span>;
    if (type === "export") return <span style={{ color: "#d2a8ff", fontSize: 12, fontFamily: "monospace" }}>ƒ</span>;
    if (type === "test")   return <span style={{ color: "#22c55e", fontSize: 12 }}>🧪</span>;
    return <span style={{ fontSize: 12 }}>•</span>;
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40"
          style={{ background: "rgba(0,0,0,0.35)", backdropFilter: "blur(2px)" }}
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        className="fixed top-0 right-0 h-full z-50 flex"
        style={{
          width: panelWidth,
          maxWidth: "92vw",
          transform: isOpen ? "translateX(0)" : "translateX(100%)",
          transition: resizingRef.current ? "none" : "transform 0.25s cubic-bezier(0.4,0,0.2,1)",
          boxShadow: isOpen ? "-8px 0 48px rgba(0,0,0,0.6)" : "none",
        }}
      >
        {/* Resize handle */}
        <div
          onMouseDown={onResizeStart}
          className="w-1 h-full flex-shrink-0 cursor-col-resize hover:bg-blue-500/40 transition-colors"
          style={{ background: "rgba(48,54,61,0.5)" }}
        />

        {/* Main panel */}
        <div
          className="flex-1 flex flex-col overflow-hidden"
          style={{ background: "#0d1117", borderLeft: "1px solid #30363d" }}
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: "1px solid #30363d" }}>
            <span className="text-base">🔍</span>
            <span className="font-semibold text-sm" style={{ color: "#e6edf3" }}>Search Code</span>
            <span className="text-[11px] ml-auto font-mono" style={{ color: "#484f58" }}>{owner}/{repo}</span>
            <button
              onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
              style={{ color: "#8b949e" }}
            >✕</button>
          </div>

          {/* Search input + filters */}
          <div className="px-4 pt-3 pb-2 space-y-2">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={e => handleSearchChange(e.target.value)}
              placeholder="Search files, functions, exports..."
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: "#161b22", border: "1px solid #30363d", color: "#e6edf3", fontFamily: "monospace" }}
            />
            {/* Type filter pills */}
            <div className="flex gap-1 flex-wrap">
              {(["all", "file", "export", "test"] as SearchTypeFilter[]).map(f => (
                <button
                  key={f}
                  onClick={() => handleFilterChange(f)}
                  className="px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-all"
                  style={{
                    background: typeFilter === f ? "rgba(88,166,255,0.15)" : "transparent",
                    color: typeFilter === f ? "#58a6ff" : "#8b949e",
                    border: `1px solid ${typeFilter === f ? "rgba(88,166,255,0.3)" : "#30363d"}`,
                  }}
                >
                  {f === "all" ? "All" : f === "file" ? "Files" : f === "export" ? "Exports" : "Tests"}
                </button>
              ))}
            </div>
          </div>

          {/* Results */}
          <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-1">
            {loading && <Spinner />}
            {error && <ErrorBanner msg={error} />}
            {!loading && !error && searchResults.length === 0 && searchQuery.length >= 2 && (
              <div className="text-center py-10 text-xs" style={{ color: "#484f58" }}>
                No results for &quot;{searchQuery}&quot;
              </div>
            )}
            {!loading && searchResults.length === 0 && searchQuery.length < 2 && (
              <div className="text-center py-10">
                <div className="text-3xl mb-3">🔎</div>
                <p className="text-sm font-medium mb-1" style={{ color: "#e6edf3" }}>Search the codebase</p>
                <p className="text-[12px]" style={{ color: "#484f58" }}>
                  Find files, exported functions, and test suites.<br />
                  Type at least 2 characters to search.
                </p>
                <p className="text-[11px] mt-3" style={{ color: "#30363d" }}>⌘K to toggle</p>
              </div>
            )}
            {!loading && searchResults.map((r, i) => (
              <button
                key={`${r.id}-${i}`}
                onClick={() => {
                  if (r.type === "export" || r.type === "test") {
                    onSelectFunction?.(r.id, r.filePath);
                  }
                  onSelectFile?.(r.filePath);
                }}
                className="w-full text-left px-3 py-2.5 rounded-lg transition-all group"
                style={{ border: "1px solid transparent" }}
                onMouseEnter={e => { e.currentTarget.style.background = "#161b22"; e.currentTarget.style.borderColor = "#30363d"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; }}
              >
                <div className="flex items-center gap-2">
                  {typeIcon(r.type)}
                  <span className="text-sm font-medium truncate flex-1" style={{ color: "#e6edf3", fontFamily: "monospace" }}>{r.name}</span>
                  <ScorePill score={Math.round(r.score)} />
                </div>
                <div className="text-[11px] truncate mt-0.5" style={{ color: "#6e7681" }}>{r.filePath}</div>
              </button>
            ))}
          </div>

          {searchTotal > 0 && (
            <div className="px-4 py-2 text-[11px] flex justify-between" style={{ borderTop: "1px solid #21262d", color: "#484f58" }}>
              <span>{searchTotal} results</span>
              <span>⌘K to toggle</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Micro-components ───────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex items-center justify-center py-10 gap-2">
      <div className="animate-spin w-4 h-4 border-2 rounded-full" style={{ borderColor: "#58a6ff", borderTopColor: "transparent" }} />
      <span className="text-xs" style={{ color: "#8b949e" }}>Searching...</span>
    </div>
  );
}

function ErrorBanner({ msg }: { msg: string }) {
  return (
    <div className="text-xs px-3 py-2 rounded-lg mt-2" style={{ background: "rgba(248,81,73,0.1)", color: "#f85149" }}>
      {msg}
    </div>
  );
}
