"use client";

import { useState, useCallback, useRef, useEffect, Suspense, useMemo } from "react";
import { fetchFileContent } from "../lib/client";
import { useRouter, useSearchParams } from "next/navigation";
import Navbar from "../components/Navbar";
import Sidebar from "../components/Sidebar";
import FileGraph from "../components/FileGraph";
import FunctionGraph from "../components/FunctionGraph";
import DetailsPanel from "../components/DetailsPanel";
import GraphControls from "../components/GraphControls";
import SearchPanel from "../components/SearchPanel";
import { GITHUB_REPO_URL } from "../lib/constants";
import type {
  FileNodeDTO,
  FunctionNodeDTO,
  FunctionFilePayload,
  ViewMode,
  IssueMapResult,
  StatusResponse,
} from "../lib/types";

function RepoPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── Load result from sessionStorage ─────────────────────────────────────────
  const [result, setResult] = useState<StatusResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem("codemap-result");
      if (stored) {
        setResult(JSON.parse(stored));
      }
    } catch {}
    setLoaded(true);
  }, []);

  // Redirect if no data
  useEffect(() => {
    if (loaded && !result?._inlineFileGraph) {
      router.replace("/");
    }
  }, [loaded, result, router]);

  // ── Trust Banner State ──────────────────────────────────────────────────────
  const [showTrustBanner, setShowTrustBanner] = useState(false);

  useEffect(() => {
    if (loaded && result?._inlineFileGraph) {
      const dismissed = localStorage.getItem("codemap-star-dismissed");
      if (!dismissed) {
        const t = setTimeout(() => setShowTrustBanner(true), 1500);
        return () => clearTimeout(t);
      }
    }
  }, [loaded, result]);

  const dismissTrustBanner = () => {
    localStorage.setItem("codemap-star-dismissed", "true");
    setShowTrustBanner(false);
  };

  // ── Core data ───────────────────────────────────────────────────────────────
  const fileGraph = result?._inlineFileGraph ?? null;
  const functionFiles: Record<string, FunctionFilePayload> | null =
    result?._functionFiles ?? null;
  const owner = result?.owner ?? searchParams.get("repo")?.split("/")[0] ?? "";
  const repo = result?.repo ?? searchParams.get("repo")?.split("/")[1] ?? "";
  const commitSha = result?.commitSha ?? "";

  // ── View state ──────────────────────────────────────────────────────────────
  const [selectedFile, setSelectedFile] = useState<FileNodeDTO | null>(null);
  const [selectedFunction, setSelectedFunction] = useState<FunctionNodeDTO | null>(null);
  const [view, setView] = useState<ViewMode>("file-graph");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);

  // ── Sidebar Tab State ───────────────────────────────────────────────────────
  const [sidebarTab, setSidebarTab] = useState<"info" | "code" | "ai">("info");

  // ── Filter state ────────────────────────────────────────────────────────────
  const [activeKinds, setActiveKinds] = useState<Set<string>>(new Set());
  const [activeLanguages, setActiveLanguages] = useState<Set<string>>(new Set());

  const filteredNodeIds = useMemo(() => {
    if (!fileGraph) return undefined;
    if (activeKinds.size === 0 && activeLanguages.size === 0) return undefined;

    const filtered = new Set<string>();
    for (const f of fileGraph.files) {
      let kindMatch = activeKinds.size === 0;
      if (activeKinds.size > 0) {
        if (activeKinds.has("entry") && f.isEntryPoint) kindMatch = true;
        else if (activeKinds.has("source") && f.kind === "source") kindMatch = true;
        else if (activeKinds.has("test") && f.kind === "test") kindMatch = true;
        else if (activeKinds.has("config") && f.kind === "config") kindMatch = true;
        else if (activeKinds.has("ui") && (f.language === "tsx" || f.language === "jsx")) kindMatch = true;
      }

      let langMatch = activeLanguages.size === 0;
      if (activeLanguages.size > 0) {
        if (activeLanguages.has(f.language)) langMatch = true;
      }

      if (kindMatch && langMatch) filtered.add(f.id);
    }
    return filtered;
  }, [fileGraph, activeKinds, activeLanguages]);

  // ── Issue mapping state ─────────────────────────────────────────────────────
  const [issueResult, setIssueResult] = useState<IssueMapResult | null>(null);
  const [isIssueLoading, setIsIssueLoading] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);

  const highlightedIssueFiles = issueResult
    ? new Map(issueResult.affectedFiles.map(f => [f.fileId, f.confidence]))
    : new Map<string, number>();

  // ── Sidebar state ───────────────────────────────────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === "undefined") return 280;
    try { return parseInt(localStorage.getItem("codemap-sidebar-width") || "280", 10); } catch { return 280; }
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const [rightSidebarWidth, setRightSidebarWidth] = useState(() => {
    if (typeof window === "undefined") return 380;
    try { return parseInt(localStorage.getItem("codemap-right-sidebar-width") || "380", 10); } catch { return 380; }
  });

  const rightIsDragging = useRef(false);
  const rightStartX = useRef(0);
  const rightStartW = useRef(380);
  const [isRightDragging, setIsRightDragging] = useState(false);

  const handleRightResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    rightIsDragging.current = true;
    setIsRightDragging(true);
    rightStartX.current = e.clientX;
    rightStartW.current = rightSidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (ev: MouseEvent) => {
      if (!rightIsDragging.current) return;
      const diff = rightStartX.current - ev.clientX; // dragging left increases width
      const maxWidth = typeof window !== "undefined" ? window.innerWidth / 2 : 800;
      const newW = Math.max(300, Math.min(maxWidth, rightStartW.current + diff));
      setRightSidebarWidth(newW);
    };

    const handleMouseUp = () => {
      rightIsDragging.current = false;
      setIsRightDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      try { localStorage.setItem("codemap-right-sidebar-width", String(rightSidebarWidth)); } catch {}
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  useEffect(() => {
    try { localStorage.setItem("codemap-right-sidebar-width", String(rightSidebarWidth)); } catch {}
  }, [rightSidebarWidth]);

  // ── Focus mode ──────────────────────────────────────────────────────────────
  const [focusMode, setFocusMode] = useState(false);

  // Auto-enable focus mode when issue is mapped
  useEffect(() => {
    if (issueResult) setFocusMode(true);
    else setFocusMode(false);
  }, [issueResult]);

  // ── Code viewer state ───────────────────────────────────────────────────────
  const [codeViewerFileId, setCodeViewerFileId] = useState<string | null>(null);
  const [codeContent, setCodeContent] = useState<string | null>(null);
  const [isLoadingCode, setIsLoadingCode] = useState(false);
  const fileContentCache = useRef<Map<string, string>>(new Map());

  // ── Chat state (preserved) ──────────────────────────────────────────────────
  interface ChatMessage { role: "user" | "assistant"; content: string; }
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);

  // ── Refs ─────────────────────────────────────────────────────────────────────
  const resetZoomRef = useRef<(() => void) | null>(null);
  const zoomToNodeRef = useRef<((fileId: string) => void) | null>(null);

  // ── History management ──────────────────────────────────────────────────────
  // Tracks whether we're currently handling a popstate (back/forward) event
  const isPopstateRef = useRef(false);

  interface HistoryEntry {
    view: ViewMode;
    fileId: string | null;
    fnId: string | null;
    fnName: string | null;
  }

  // Build URL from state
  const buildUrl = useCallback((entry: HistoryEntry) => {
    const params = new URLSearchParams();
    params.set("repo", `${owner}/${repo}`);
    if (entry.fileId) params.set("file", entry.fileId);
    if (entry.view === "function-graph" && entry.fnName) params.set("fn", entry.fnName);
    return `/repo?${params.toString()}`;
  }, [owner, repo]);

  // Push a new history entry (called on navigation actions)
  const pushHistory = useCallback((entry: HistoryEntry) => {
    if (isPopstateRef.current) return; // don't push when handling popstate
    const url = buildUrl(entry);
    window.history.pushState(
      { view: entry.view, fileId: entry.fileId, fnId: entry.fnId, fnName: entry.fnName },
      "",
      url
    );
  }, [buildUrl]);

  // Listen for browser back/forward
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      isPopstateRef.current = true;
      const state = e.state as HistoryEntry | null;

      if (!state) {
        // No state = initial entry = file graph with nothing selected
        setView("file-graph");
        setSelectedFile(null);
        setSelectedFunction(null);
        setCodeViewerFileId(null);
        setCodeContent(null);
        isPopstateRef.current = false;
        return;
      }

      // Restore view
      setView(state.view || "file-graph");

      // Restore file selection
      if (state.fileId && fileGraph) {
        const file = fileGraph.files.find(f => f.id === state.fileId);
        setSelectedFile(file ?? null);
      } else {
        setSelectedFile(null);
      }

      // Restore function selection
      if (state.fnId && state.view === "function-graph" && functionFiles) {
        let foundFn: FunctionNodeDTO | null = null;
        for (const payload of Object.values(functionFiles)) {
          const fn = payload.functions.find(f => f.id === state.fnId);
          if (fn) { foundFn = fn; break; }
        }
        setSelectedFunction(foundFn);
      } else {
        setSelectedFunction(null);
      }

      setCodeViewerFileId(null);
      setCodeContent(null);

      isPopstateRef.current = false;
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [fileGraph, functionFiles]);

  // Set initial history entry (replaceState so back goes to landing)
  useEffect(() => {
    if (!result?.owner) return;
    const params = new URLSearchParams();
    params.set("repo", `${owner}/${repo}`);
    window.history.replaceState(
      { view: "file-graph", fileId: null, fnId: null, fnName: null },
      "",
      `/repo?${params.toString()}`
    );
  }, [result, owner, repo]); // only on initial load

  // ── All functions (for IssueMapper) ─────────────────────────────────────────
  const allFunctions = fileGraph
    ? fileGraph.files.flatMap(f =>
        (functionFiles?.[f.id.replace(/[^a-zA-Z0-9]/g, "_")] ?? functionFiles?.[f.id])?.functions ?? []
      )
    : [];

  // ── Connected files for chat ────────────────────────────────────────────────
  const getConnectedFileIds = useCallback((fileId: string): string[] => {
    if (!fileGraph) return [];
    const connected = new Set<string>();
    for (const e of fileGraph.importEdges) {
      if (e.source === fileId) connected.add(e.target);
      if (e.target === fileId) connected.add(e.source);
    }
    return [...connected].slice(0, 5);
  }, [fileGraph]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleFileClick = useCallback((file: FileNodeDTO | null) => {
    if (!file) {
      setSelectedFile(null);
      setSidebarTab("info");
      return;
    }
    setSelectedFile(file);
    setCodeViewerFileId(null);
    setCodeContent(null);
    // Push history: navigated to a file
    pushHistory({ view: "file-graph", fileId: file.id, fnId: null, fnName: null });
  }, [pushHistory]);

  const handleFileNavigate = useCallback((fileId: string) => {
    if (!fileGraph) return;
    const file = fileGraph.files.find(f => f.id === fileId);
    if (file) {
      setSelectedFile(file);
      setCodeViewerFileId(null);
      setCodeContent(null);
      pushHistory({ view: "file-graph", fileId: file.id, fnId: null, fnName: null });
    }
  }, [fileGraph, pushHistory]);

  const handleFunctionClick = useCallback((fn: FunctionNodeDTO) => {
    setSelectedFunction(fn);
    setView("function-graph");
    pushHistory({ view: "function-graph", fileId: selectedFile?.id ?? null, fnId: fn.id, fnName: fn.name });
  }, [pushHistory, selectedFile]);

  const handleFunctionNavigateById = useCallback(
    (functionId: string, filePath: string) => {
      if (!functionFiles) return;
      for (const payload of Object.values(functionFiles)) {
        const fn = payload.functions.find(f => f.id === functionId || f.filePath === filePath);
        if (fn) {
          setSelectedFunction(fn);
          setView("function-graph");
          pushHistory({ view: "function-graph", fileId: selectedFile?.id ?? null, fnId: fn.id, fnName: fn.name });
          return;
        }
      }
      const file = fileGraph?.files.find(f => f.id === filePath);
      if (file) {
        setSelectedFile(file);
        pushHistory({ view: "file-graph", fileId: file.id, fnId: null, fnName: null });
      }
    },
    [functionFiles, fileGraph, pushHistory, selectedFile]
  );

  const handleFunctionNavigate = useCallback((fn: FunctionNodeDTO) => {
    setSelectedFunction(fn);
    pushHistory({ view: "function-graph", fileId: selectedFile?.id ?? null, fnId: fn.id, fnName: fn.name });
  }, [pushHistory, selectedFile]);

  const handleBackToFileGraph = useCallback(() => {
    setView("file-graph");
    setSelectedFunction(null);
    pushHistory({ view: "file-graph", fileId: selectedFile?.id ?? null, fnId: null, fnName: null });
  }, [pushHistory, selectedFile]);

  const handleViewChange = useCallback((newView: ViewMode) => {
    if (newView === "function-graph" && !selectedFunction) return;
    setView(newView);
  }, [selectedFunction]);

  const handleResetView = useCallback(() => {
    setSearchQuery("");
    resetZoomRef.current?.();
  }, []);

  const handleBackToFile = useCallback(() => {
    setView("file-graph");
    setSelectedFunction(null);
    pushHistory({ view: "file-graph", fileId: selectedFile?.id ?? null, fnId: null, fnName: null });
  }, [pushHistory, selectedFile]);

  const handleIssueResult = useCallback((result: IssueMapResult) => {
    setIssueResult(result);
    setIssueError(null);
  }, []);

  const handleIssueClear = useCallback(() => {
    setIssueResult(null);
    setIssueError(null);
    setFocusMode(false);
  }, []);

  const handleZoomToNode = useCallback((fileId: string) => {
    if (view !== "file-graph") {
      setView("file-graph");
      setSelectedFunction(null);
    }
    setTimeout(() => {
      zoomToNodeRef.current?.(fileId);
    }, 50);
  }, [view]);

  const handleAnalyzeAnother = useCallback(() => {
    sessionStorage.removeItem("codemap-result");
    router.push("/");
  }, [router]);

  // ── View Source ─────────────────────────────────────────────────────────────
  const handleViewSource = useCallback(async () => {
    if (!selectedFile) return;

    if (codeViewerFileId === selectedFile.id && codeContent) {
      // already loaded
      return;
    }

    const cached = fileContentCache.current.get(selectedFile.id);
    if (cached) {
      setCodeViewerFileId(selectedFile.id);
      setCodeContent(cached);
      return;
    }

    setIsLoadingCode(true);
    try {
      const data = await fetchFileContent(owner, repo, commitSha, selectedFile.path);
      const text = data.content || "";
      fileContentCache.current.set(selectedFile.id, text);
      setCodeViewerFileId(selectedFile.id);
      setCodeContent(text);
    } catch (err) {
      console.error("Failed to fetch source:", err);
    } finally {
      setIsLoadingCode(false);
    }
  }, [selectedFile, codeViewerFileId, codeContent, owner, repo, commitSha]);

  // Auto-fetch code when switching to code tab
  useEffect(() => {
    if (sidebarTab === "code" && selectedFile && (!codeContent || codeViewerFileId !== selectedFile.id)) {
      handleViewSource();
    }
  }, [sidebarTab, selectedFile, codeContent, codeViewerFileId, handleViewSource]);



  // ── Open Chat ───────────────────────────────────────────────────────────────
  const handleOpenChat = useCallback((fileId: string) => {
    // Switch to AI tab in the details panel
    setSidebarTab("ai");
  }, []);

  // ── SearchPanel callbacks ─────────────────────────────────────────────────
  const handleSearchPanelClose = useCallback(() => setSearchPanelOpen(false), []);
  const handleSearchPanelSelectFile = useCallback((filePath: string) => {
    const file = fileGraph?.files.find((f) => f.id === filePath) ?? null;
    if (file) {
      setSelectedFile(file);
      pushHistory({ view: "file-graph", fileId: file.id, fnId: null, fnName: null });
    }
  }, [fileGraph, pushHistory]);

  // ── Cmd+K shortcut ────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchPanelOpen(prev => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── Loading / redirect state ──────────────────────────────────────────────
  if (!loaded || !fileGraph) {
    return (
      <div className="flex items-center justify-center h-screen" style={{ background: "#0a0a0f" }}>
        <div className="flex items-center gap-3">
          <span className="inline-block w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: "#6366f1", borderTopColor: "transparent" }} />
          <span className="text-sm" style={{ color: "#8b949e" }}>Loading graph...</span>
        </div>
      </div>
    );
  }



  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: "#0d1117" }}>
      {/* ── Navbar ──────────────────────────────────────────────────────── */}
      <Navbar owner={owner} repo={repo} onAnalyzeAnother={handleAnalyzeAnother} />

      {/* ── Main content ───────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Left Sidebar ───────────────────────────────────────────── */}
        <Sidebar
          width={sidebarWidth}
          collapsed={sidebarCollapsed}
          onWidthChange={setSidebarWidth}
          onCollapsedChange={setSidebarCollapsed}
          files={fileGraph.files}
          edges={fileGraph.importEdges}
          owner={owner}
          repo={repo}
          commitSha={commitSha}
          issueResult={issueResult}
          isIssueLoading={isIssueLoading}
          issueError={issueError}
          onIssueResult={handleIssueResult}
          onIssueClear={handleIssueClear}
          setIssueLoading={setIsIssueLoading}
          setIssueError={setIssueError}
          onFileSelect={handleFileClick}
          onZoomToNode={handleZoomToNode}
          allFunctions={allFunctions}
        />

        {/* ── Center: Graph Canvas ───────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Controls bar */}
          <div className="px-3 pt-2">
            <GraphControls
              view={view}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              onViewChange={handleViewChange}
              onResetView={handleResetView}
              onSearchOpen={() => setSearchPanelOpen(true)}
              fileCount={fileGraph.files.length}
              edgeCount={fileGraph.importEdges.length}
              hasFunctionSelected={!!selectedFunction}
              focusMode={focusMode}
              onFocusModeToggle={() => setFocusMode(prev => !prev)}
              hasIssueResult={!!issueResult}
              activeKinds={activeKinds}
              activeLanguages={activeLanguages}
              onKindsChange={setActiveKinds}
              onLanguagesChange={setActiveLanguages}
            />
          </div>

          {/* Graph */}
          <div className="flex-1 overflow-hidden">
            {view === "file-graph" ? (
              <FileGraph
                files={fileGraph.files}
                edges={fileGraph.importEdges}
                onFileClick={handleFileClick}
                owner={owner}
                repo={repo}
                searchQuery={searchQuery}
                selectedFileId={selectedFile?.id ?? null}
                resetZoomRef={resetZoomRef}
                highlightedIssueFiles={highlightedIssueFiles}
                focusMode={focusMode}
                zoomToNodeRef={zoomToNodeRef}
                filteredNodeIds={filteredNodeIds}
              />
            ) : selectedFunction && functionFiles ? (
              <FunctionGraph
                selectedFunction={selectedFunction}
                functionFiles={functionFiles}
                owner={owner}
                repo={repo}
                commitSha={commitSha}
                onFunctionNavigate={handleFunctionNavigate}
                onBackToFileGraph={handleBackToFileGraph}
                onBackToFile={handleBackToFile}
              />
            ) : (
              <div
                className="flex items-center justify-center h-full"
                style={{ background: "#0d1117", color: "#484f58" }}
              >
                <div className="text-center">
                  <p className="text-lg mb-2">No function selected</p>
                  <p className="text-sm">Click a file, then a function.</p>
                  <button
                    onClick={handleBackToFileGraph}
                    className="mt-4 px-4 py-2 rounded-lg text-sm"
                    style={{ background: "#1c2128", border: "1px solid #30363d", color: "#8b949e" }}
                  >
                    Back to file graph
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Right Panel ────────────────────────────────────────────── */}
        <div 
          className="shrink-0 flex overflow-hidden"
          style={{ 
            width: selectedFile ? `${rightSidebarWidth + 12}px` : "0px",
            transition: isRightDragging ? "none" : "width 0.25s cubic-bezier(0.4, 0, 0.2, 1)"
          }}
        >
          {selectedFile && (
            <>
              <div 
                onMouseDown={handleRightResizeMouseDown}
              style={{
                cursor: "col-resize",
                width: "12px",
                flexShrink: 0,
                display: "flex",
                justifyContent: "center",
                background: "transparent",
                zIndex: 10
              }}
              className="hover:bg-blue-500/20 transition-colors group"
              title="Resize sidebar"
            >
              <div className="h-full group-hover:bg-blue-500 transition-colors" style={{ width: "1px", background: "#21262d" }} />
            </div>
            <div
              className="shrink-0 overflow-hidden"
              style={{
                width: `${rightSidebarWidth}px`,
              }}
            >
            <DetailsPanel
              file={selectedFile}
              edges={fileGraph.importEdges}
              owner={owner}
              repo={repo}
              commitSha={commitSha}
              functionFiles={functionFiles}
              onClose={() => setSelectedFile(null)}
              onFileNavigate={handleFileNavigate}
              onFunctionClick={handleFunctionClick}
              issueResult={issueResult}
              codeContent={codeViewerFileId === selectedFile.id ? codeContent : null}
              onViewSource={handleViewSource}
              isLoadingCode={isLoadingCode}
              onOpenChat={handleOpenChat}
              activeTab={sidebarTab}
              onTabChange={setSidebarTab}
              chatMessages={chatMessages}
              setChatMessages={setChatMessages}
              isChatLoading={isChatLoading}
              setIsChatLoading={setIsChatLoading}
            />
            </div>
          </>
        )}
        </div>
      </div>

      {/* ── Search Panel ─────────────────────────────────────────────── */}
      <SearchPanel
        isOpen={searchPanelOpen}
        onClose={handleSearchPanelClose}
        owner={owner}
        repo={repo}
        onSelectFile={handleSearchPanelSelectFile}
        onSelectFunction={handleFunctionNavigateById}
      />

      {/* ── Trust Banner ─────────────────────────────────────────────────── */}
      {showTrustBanner && (
        <div className="fixed bottom-6 right-6 z-50 animate-in fade-in slide-in-from-bottom-4 duration-500 w-auto">
          <div className="bg-[#161b22] border border-[#30363d] shadow-2xl rounded-xl p-3 pr-10 flex items-center justify-between gap-4 relative">
            <button
              onClick={dismissTrustBanner}
              className="absolute top-1/2 -translate-y-1/2 right-3 p-1 text-[#8b949e] hover:text-[#c9d1d9] transition-colors rounded-md"
              title="Dismiss"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-[#e6edf3] whitespace-nowrap">Enjoying CodeMap?</span>
              <span className="text-xs text-[#8b949e] hidden sm:inline whitespace-nowrap">
                Support our open-source development by dropping a star.
              </span>
            </div>
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={dismissTrustBanner}
              className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg bg-[#21262d] border border-[#30363d] hover:border-[#8b949e] hover:bg-[#30363d] transition-all text-xs font-semibold text-[#c9d1d9] whitespace-nowrap"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.699-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
              </svg>
              Star on GitHub
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export default function RepoPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-screen" style={{ background: "#0a0a0f" }}>
        <span className="text-sm" style={{ color: "#8b949e" }}>Loading...</span>
      </div>
    }>
      <RepoPageContent />
    </Suspense>
  );
}
