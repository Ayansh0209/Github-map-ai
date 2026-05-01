"use client";

// SearchPanel.tsx
// Sidebar overlay with two modes:
//   1. Search — find files, exports, tests
//   2. Diagnose — map a bug/issue to exact files + functions
// Panel is resizable. Diagnose results drive graph highlighting.

import { useState, useCallback, useRef, useEffect } from "react";
import { searchCode, searchIssues } from "../lib/client";
import type { SearchResultItem, IssueMappingResult, CandidateFile, CandidateFunction } from "../lib/types";

// ── Types ──────────────────────────────────────────────────────────────────────

interface SearchPanelProps {
  isOpen: boolean;
  onClose: () => void;
  owner: string;
  repo: string;
  onSelectFile?: (filePath: string, issueContext?: IssueFileContext) => void;
  onSelectFunction?: (functionId: string, filePath: string) => void;
  onHighlightFiles?: (filePaths: string[]) => void;
  onClearHighlight?: () => void;
}

export interface IssueFileContext {
  issueText: string;
  relevanceScore: number;
  matchedReasons: string[];
  matchedKeywords: string[];
}

type SearchTab = "search" | "diagnose";
type SearchTypeFilter = "all" | "file" | "export" | "test";

const MAX_HISTORY = 5;

// ── Helpers ────────────────────────────────────────────────────────────────────

function ConfidenceBar({ score }: { score: number }) {
  const color = score >= 70 ? "#22c55e" : score >= 40 ? "#f0883e" : "#f85149";
  const label = score >= 70 ? "High" : score >= 40 ? "Medium" : "Low";
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-[11px]" style={{ color: "#8b949e" }}>Confidence</span>
      <div className="flex-1 rounded-full h-1.5 overflow-hidden" style={{ background: "#30363d" }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${score}%`, background: color }}
        />
      </div>
      <span className="text-[11px] font-semibold" style={{ color }}>{score}% {label}</span>
    </div>
  );
}

function KeywordBadge({ keyword }: { keyword: string }) {
  return (
    <span
      className="px-2 py-0.5 rounded-full text-[10px] font-medium"
      style={{ background: "rgba(88,166,255,0.12)", color: "#58a6ff", border: "1px solid rgba(88,166,255,0.2)" }}
    >
      {keyword}
    </span>
  );
}

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
  onHighlightFiles,
  onClearHighlight,
}: SearchPanelProps) {
  const [activeTab, setActiveTab] = useState<SearchTab>("search");

  // Search tab state
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<SearchTypeFilter>("all");
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);

  // Diagnose tab state
  const [diagnoseQuery, setDiagnoseQuery] = useState("");
  const [diagnoseResult, setDiagnoseResult] = useState<IssueMappingResult | null>(null);
  const [diagnoseHistory, setDiagnoseHistory] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);

  // Shared state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Panel width (resizable)
  const [panelWidth, setPanelWidth] = useState(440);
  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(440);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const diagnoseInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Focus on open
  useEffect(() => {
    if (!isOpen) return;
    const ref = activeTab === "search" ? searchInputRef : diagnoseInputRef;
    setTimeout(() => ref.current?.focus(), 150);
  }, [isOpen, activeTab]);

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && isOpen) onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  // Clear highlights when panel closes
  useEffect(() => {
    if (!isOpen) { onClearHighlight?.(); setActiveFile(null); }
  }, [isOpen, onClearHighlight]);

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

  // ── Diagnose logic ────────────────────────────────────────────────────────────

  const performDiagnose = useCallback(async (q: string) => {
    if (q.trim().length < 3) return;
    console.log("[Diagnose] Starting query:", q, "owner:", owner, "repo:", repo);
    setLoading(true); setError(null); setDiagnoseResult(null); setActiveFile(null);
    onClearHighlight?.();
    try {
      const result = await searchIssues(owner, repo, q, 10);
      console.log("[Diagnose] API result:", result);
      setDiagnoseResult(result);
      // Auto-highlight top files on the graph
      if (result.topFiles.length > 0) {
        const paths = result.topFiles.map(f => f.filePath);
        console.log("[Diagnose] Highlighting files:", paths);
        onHighlightFiles?.(paths);
      } else {
        console.warn("[Diagnose] No topFiles returned — no nodes will be highlighted");
      }
      // Save to history
      setDiagnoseHistory(prev => {
        const next = [q, ...prev.filter(h => h !== q)].slice(0, MAX_HISTORY);
        return next;
      });
    } catch (err) {
      console.error("[Diagnose] Error:", err);
      setError((err as Error).message);
    }
    finally { setLoading(false); }
  }, [owner, repo, onHighlightFiles, onClearHighlight]);

  const handleDiagnoseKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") performDiagnose(diagnoseQuery);
  };

  const handleFileSelect = (file: CandidateFile) => {
    setActiveFile(file.filePath);
    onSelectFile?.(file.filePath, {
      issueText: diagnoseResult?.issueText ?? "",
      relevanceScore: file.score,
      matchedReasons: file.matchedReasons,
      matchedKeywords: diagnoseResult?.matchedKeywords ?? [],
    });
  };

  const handleFunctionSelect = (fn: CandidateFunction) => {
    setActiveFile(fn.filePath);
    onSelectFunction?.(fn.functionId, fn.filePath);
    onSelectFile?.(fn.filePath, {
      issueText: diagnoseResult?.issueText ?? "",
      relevanceScore: fn.score,
      matchedReasons: fn.matchedReasons,
      matchedKeywords: diagnoseResult?.matchedKeywords ?? [],
    });
  };

  const handleTabSwitch = (tab: SearchTab) => {
    setActiveTab(tab);
    setError(null);
    if (tab === "search") { onClearHighlight?.(); setActiveFile(null); }
    if (tab === "diagnose" && diagnoseResult) {
      onHighlightFiles?.(diagnoseResult.topFiles.map(f => f.filePath));
    }
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
            <span className="font-semibold text-sm" style={{ color: "#e6edf3" }}>
              {activeTab === "search" ? "Search Code" : "Diagnose Issue"}
            </span>
            <span className="text-[11px] ml-auto font-mono" style={{ color: "#484f58" }}>{owner}/{repo}</span>
            <button
              onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
              style={{ color: "#8b949e" }}
            >✕</button>
          </div>

          {/* Tabs */}
          <div className="flex px-4 gap-1 pt-2" style={{ borderBottom: "1px solid #21262d" }}>
            {(["search", "diagnose"] as SearchTab[]).map(tab => (
              <button
                key={tab}
                onClick={() => handleTabSwitch(tab)}
                className="px-3 py-1.5 text-xs font-medium rounded-t transition-all"
                style={{
                  color: activeTab === tab ? "#e6edf3" : "#8b949e",
                  background: activeTab === tab ? "#161b22" : "transparent",
                  borderBottom: activeTab === tab ? "2px solid #58a6ff" : "2px solid transparent",
                }}
              >
                {tab === "search" ? "🔎 Search" : "🩺 Diagnose"}
              </button>
            ))}
          </div>

          {/* ── SEARCH TAB ── */}
          {activeTab === "search" && (
            <>
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

              <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-1">
                {loading && <Spinner label="Searching..." />}
                {error && <ErrorBanner msg={error} />}
                {!loading && !error && searchResults.length === 0 && searchQuery.length >= 2 && (
                  <EmptyState msg={`No results for "${searchQuery}"`} />
                )}
                {!loading && searchResults.map((r, i) => (
                  <button
                    key={`${r.id}-${i}`}
                    onClick={() => onSelectFile?.(r.filePath)}
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
            </>
          )}

          {/* ── DIAGNOSE TAB ── */}
          {activeTab === "diagnose" && (
            <>
              <div className="px-4 pt-3 pb-2 space-y-2">
                <div className="relative">
                  <input
                    ref={diagnoseInputRef}
                    type="text"
                    value={diagnoseQuery}
                    onChange={e => setDiagnoseQuery(e.target.value)}
                    onKeyDown={handleDiagnoseKeyDown}
                    placeholder="Describe a bug, error, or issue..."
                    className="w-full px-3 py-2 pr-20 rounded-lg text-sm outline-none"
                    style={{ background: "#161b22", border: "1px solid #30363d", color: "#e6edf3" }}
                  />
                  <button
                    onClick={() => performDiagnose(diagnoseQuery)}
                    disabled={loading || diagnoseQuery.trim().length < 3}
                    className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1 rounded text-[11px] font-semibold transition-all disabled:opacity-40"
                    style={{ background: "rgba(88,166,255,0.15)", color: "#58a6ff", border: "1px solid rgba(88,166,255,0.25)" }}
                  >
                    {loading ? "..." : "Run"}
                  </button>
                </div>
                <p className="text-[11px]" style={{ color: "#484f58" }}>
                  Press Enter or Run · CodeMap will map your issue to the most likely files &amp; functions
                </p>
              </div>

              {/* Recent history */}
              {!diagnoseResult && diagnoseHistory.length > 0 && (
                <div className="px-4 pb-3">
                  <p className="text-[10px] uppercase tracking-widest mb-2" style={{ color: "#484f58" }}>Recent</p>
                  <div className="space-y-1">
                    {diagnoseHistory.map((h, i) => (
                      <button
                        key={i}
                        onClick={() => { setDiagnoseQuery(h); performDiagnose(h); }}
                        className="w-full text-left px-2.5 py-1.5 rounded-lg text-[12px] transition-colors"
                        style={{ background: "#161b22", color: "#8b949e", border: "1px solid #21262d" }}
                        onMouseEnter={e => { e.currentTarget.style.color = "#e6edf3"; }}
                        onMouseLeave={e => { e.currentTarget.style.color = "#8b949e"; }}
                      >
                        🕐 {h}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex-1 overflow-y-auto px-4 pb-4">
                {loading && <Spinner label="Diagnosing..." />}
                {error && <ErrorBanner msg={error} />}

                {!loading && !error && !diagnoseResult && diagnoseQuery.length === 0 && (
                  <div className="text-center py-10">
                    <div className="text-3xl mb-3">🩺</div>
                    <p className="text-sm font-medium mb-1" style={{ color: "#e6edf3" }}>Issue → Code Diagnosis</p>
                    <p className="text-[12px]" style={{ color: "#484f58" }}>
                      Describe any bug, error message, or feature request.<br />
                      CodeMap will deterministically rank the most likely files and functions.
                    </p>
                  </div>
                )}

                {!loading && diagnoseResult && (
                  <div className="space-y-5 pt-1">
                    {/* Confidence + keywords */}
                    <div className="rounded-xl p-3" style={{ background: "#161b22", border: "1px solid #30363d" }}>
                      <ConfidenceBar score={diagnoseResult.confidenceScore} />
                      {diagnoseResult.matchedKeywords.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {diagnoseResult.matchedKeywords.map((kw, i) => <KeywordBadge key={i} keyword={kw} />)}
                        </div>
                      )}
                    </div>

                    {/* Top Files */}
                    {diagnoseResult.topFiles.length > 0 && (
                      <div>
                        <p className="text-[11px] uppercase tracking-widest mb-2 font-semibold" style={{ color: "#58a6ff" }}>
                          📁 Top Files
                        </p>
                        <div className="space-y-1.5">
                          {diagnoseResult.topFiles.map((file, i) => (
                            <button
                              key={i}
                              onClick={() => handleFileSelect(file)}
                              className="w-full text-left rounded-xl p-3 transition-all"
                              style={{
                                background: activeFile === file.filePath ? "rgba(88,166,255,0.08)" : "#161b22",
                                border: `1px solid ${activeFile === file.filePath ? "rgba(88,166,255,0.3)" : "#21262d"}`,
                              }}
                              onMouseEnter={e => { if (activeFile !== file.filePath) e.currentTarget.style.borderColor = "#30363d"; }}
                              onMouseLeave={e => { if (activeFile !== file.filePath) e.currentTarget.style.borderColor = "#21262d"; }}
                            >
                              <div className="flex items-center gap-2 mb-1.5">
                                <span style={{ fontSize: 12 }}>📄</span>
                                <span className="flex-1 text-[12px] font-medium truncate" style={{ color: "#e6edf3", fontFamily: "monospace" }}>
                                  {file.filePath.split("/").pop()}
                                </span>
                                <ScorePill score={file.score} />
                              </div>
                              <div className="text-[10px] truncate mb-2" style={{ color: "#6e7681" }}>{file.filePath}</div>
                              {/* Top reason only */}
                              {file.matchedReasons[0] && (
                                <div className="text-[10px] italic" style={{ color: "#484f58" }}>
                                  ↳ {file.matchedReasons[0]}
                                </div>
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Top Functions */}
                    {diagnoseResult.topFunctions.length > 0 && (
                      <div>
                        <p className="text-[11px] uppercase tracking-widest mb-2 font-semibold" style={{ color: "#d2a8ff" }}>
                          ƒ Top Functions
                        </p>
                        <div className="space-y-1.5">
                          {diagnoseResult.topFunctions.map((fn, i) => {
                            const fnName = fn.functionId.split("::").pop() ?? fn.functionId;
                            return (
                              <button
                                key={i}
                                onClick={() => handleFunctionSelect(fn)}
                                className="w-full text-left rounded-xl p-3 transition-all"
                                style={{ background: "#161b22", border: "1px solid #21262d" }}
                                onMouseEnter={e => { e.currentTarget.style.borderColor = "#30363d"; }}
                                onMouseLeave={e => { e.currentTarget.style.borderColor = "#21262d"; }}
                              >
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-[12px]" style={{ color: "#d2a8ff", fontFamily: "monospace" }}>ƒ</span>
                                  <span className="flex-1 text-[12px] font-medium truncate" style={{ color: "#e6edf3", fontFamily: "monospace" }}>
                                    {fnName}
                                  </span>
                                  <ScorePill score={fn.score} />
                                </div>
                                <div className="text-[10px] truncate" style={{ color: "#6e7681" }}>{fn.filePath}</div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {diagnoseResult.topFiles.length === 0 && diagnoseResult.topFunctions.length === 0 && (
                      <EmptyState msg="No likely files found. Try a more specific description." />
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ── Micro-components ───────────────────────────────────────────────────────────

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-10 gap-2">
      <div className="animate-spin w-4 h-4 border-2 rounded-full" style={{ borderColor: "#58a6ff", borderTopColor: "transparent" }} />
      <span className="text-xs" style={{ color: "#8b949e" }}>{label}</span>
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

function EmptyState({ msg }: { msg: string }) {
  return (
    <div className="text-center py-10 text-xs" style={{ color: "#484f58" }}>{msg}</div>
  );
}
