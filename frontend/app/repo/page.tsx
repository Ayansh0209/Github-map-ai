"use client";

import { useState, useCallback, useRef, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Navbar from "../components/Navbar";
import Sidebar from "../components/Sidebar";
import FileGraph from "../components/FileGraph";
import FunctionGraph from "../components/FunctionGraph";
import DetailsPanel from "../components/DetailsPanel";
import GraphControls from "../components/GraphControls";
import SearchPanel from "../components/SearchPanel";
import ChatDrawer from "../components/ChatDrawer";
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
  const [codeMaxLines, setCodeMaxLines] = useState(200);
  const fileContentCache = useRef<Map<string, string>>(new Map());

  // ── Chat state ──────────────────────────────────────────────────────────────
  const [chatOpen, setChatOpen] = useState(false);
  const [chatFileId, setChatFileId] = useState<string | null>(null);

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

  const handleFileClick = useCallback((file: FileNodeDTO) => {
    setSelectedFile(file);
    setCodeViewerFileId(null);
    setCodeContent(null);
    setCodeMaxLines(200);
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
      setCodeMaxLines(200);
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

    if (codeViewerFileId === selectedFile.id) {
      setCodeViewerFileId(null);
      setCodeContent(null);
      return;
    }

    const cached = fileContentCache.current.get(selectedFile.id);
    if (cached) {
      setCodeViewerFileId(selectedFile.id);
      setCodeContent(cached);
      setCodeMaxLines(selectedFile.lineCount > 500 ? 200 : selectedFile.lineCount);
      return;
    }

    setIsLoadingCode(true);
    try {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${selectedFile.path}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      fileContentCache.current.set(selectedFile.id, text);
      setCodeViewerFileId(selectedFile.id);
      setCodeContent(text);
      setCodeMaxLines(selectedFile.lineCount > 500 ? 200 : selectedFile.lineCount);
    } catch (err) {
      console.error("Failed to fetch source:", err);
    } finally {
      setIsLoadingCode(false);
    }
  }, [selectedFile, codeViewerFileId, owner, repo, commitSha]);

  const handleLoadMoreCode = useCallback(() => {
    setCodeMaxLines(prev => prev + 150);
  }, []);

  // ── Open Chat ───────────────────────────────────────────────────────────────
  const handleOpenChat = useCallback((fileId: string) => {
    setChatFileId(fileId);
    setChatOpen(true);
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

  const chatFileName = chatFileId?.split("/").pop() || chatFileId || "";

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
        {selectedFile && (
          <div
            className="shrink-0 overflow-hidden"
            style={{
              width: "380px",
              borderLeft: "1px solid #21262d",
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
              codeMaxLines={codeMaxLines}
              onLoadMoreCode={handleLoadMoreCode}
              onOpenChat={issueResult ? handleOpenChat : undefined}
            />
          </div>
        )}
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

      {/* ── Chat Drawer ──────────────────────────────────────────────── */}
      {chatOpen && chatFileId && issueResult && (
        <ChatDrawer
          isOpen={chatOpen}
          onClose={() => setChatOpen(false)}
          owner={owner}
          repo={repo}
          commitSha={commitSha}
          issueNumber={issueResult.issueNumber}
          fileId={chatFileId}
          fileName={chatFileName}
          connectedFileIds={getConnectedFileIds(chatFileId)}
        />
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
