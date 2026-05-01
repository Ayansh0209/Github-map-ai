"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import InputBar from "./components/InputBar";
import ProgressBar from "./components/ProgressBar";
import FileGraph from "./components/FileGraph";
import FunctionGraph from "./components/FunctionGraph";
import DetailsPanel from "./components/DetailsPanel";
import StatsBar from "./components/StatsBar";
import GraphControls from "./components/GraphControls";
import SearchPanel from "./components/SearchPanel";
import { useJobPolling } from "./hooks/useJobPolling";
import { submitAnalysis } from "./lib/client";
import type {
  FileNodeDTO,
  FunctionNodeDTO,
  FunctionFilePayload,
  ViewMode,
} from "./lib/types";

export default function Home() {
  const {
    status,
    progress,
    step,
    position,
    error: pollError,
    result,
    startPolling,
    reset,
  } = useJobPolling();

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileNodeDTO | null>(null);
  const [selectedFunction, setSelectedFunction] =
    useState<FunctionNodeDTO | null>(null);
  const [view, setView] = useState<ViewMode>("file-graph");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const resetZoomRef = useRef<(() => void) | null>(null);

  const isLoading =
    status === "submitting" ||
    status === "processing" ||
    status === "queued" ||
    status === "delayed";
  const isDone = status === "done" && result?._inlineFileGraph;

  // Extract data from result
  const fileGraph = result?._inlineFileGraph ?? null;
  const functionFiles: Record<string, FunctionFilePayload> | null =
    result?._functionFiles ?? null;
  const owner = result?.owner ?? "";
  const repo = result?.repo ?? "";
  const commitSha = result?.commitSha ?? "";

  // ── Handlers ────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (repoUrl: string) => {
      setSubmitError(null);
      setSelectedFile(null);
      setSelectedFunction(null);
      setView("file-graph");
      setSearchQuery("");

      try {
        const { jobId } = await submitAnalysis(repoUrl);
        startPolling(jobId);
      } catch (err) {
        setSubmitError(
          err instanceof Error ? err.message : "Failed to submit"
        );
      }
    },
    [startPolling]
  );

  const handleFileClick = useCallback((file: FileNodeDTO) => {
    setSelectedFile(file);
  }, []);

  const handleFileNavigate = useCallback(
    (fileId: string) => {
      if (!fileGraph) return;
      const file = fileGraph.files.find((f) => f.id === fileId);
      if (file) setSelectedFile(file);
    },
    [fileGraph]
  );

  const handleFunctionClick = useCallback(
    (fn: FunctionNodeDTO) => {
      setSelectedFunction(fn);
      setView("function-graph");
    },
    []
  );

  const handleFunctionNavigate = useCallback(
    (fn: FunctionNodeDTO) => {
      setSelectedFunction(fn);
      // Stay in function-graph view
    },
    []
  );

  const handleBackToFileGraph = useCallback(() => {
    setView("file-graph");
    setSelectedFunction(null);
  }, []);

  const handleViewChange = useCallback(
    (newView: ViewMode) => {
      if (newView === "function-graph" && !selectedFunction) return;
      setView(newView);
    },
    [selectedFunction]
  );

  const handleResetView = useCallback(() => {
    setSearchQuery("");
    resetZoomRef.current?.();
  }, []);

  const handleBackToFile = useCallback(() => {
    setView("file-graph");
    setSelectedFunction(null);
    // selectedFile stays intact — DetailsPanel reopens automatically
  }, []);

  // ── URL param sync (state → URL) ──────────────────────────────────────────
  useEffect(() => {
    if (!result?.owner) return;
    const params = new URLSearchParams();
    params.set("repo", `${owner}/${repo}`);
    if (selectedFile) params.set("file", selectedFile.id);
    if (view === "function-graph" && selectedFunction) params.set("fn", selectedFunction.name);
    window.history.pushState({}, "", `${window.location.pathname}?${params.toString()}`);
  }, [owner, repo, selectedFile, selectedFunction, view, result]);

  // ── popstate — browser back/forward ──────────────────────────────────────
  useEffect(() => {
    const handler = () => {
      const params = new URLSearchParams(window.location.search);
      const fileParam = params.get("file");
      const fnParam = params.get("fn");
      if (!fileParam) {
        setSelectedFile(null); setSelectedFunction(null); setView("file-graph");
      } else if (!fnParam) {
        const f = fileGraph?.files.find(f => f.id === fileParam);
        if (f) setSelectedFile(f);
        setSelectedFunction(null); setView("file-graph");
      }
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [fileGraph]);

  const handleReset = useCallback(() => {
    reset();
    setSelectedFile(null);
    setSelectedFunction(null);
    setView("file-graph");
    setSearchQuery("");
    setSearchPanelOpen(false);
  }, [reset]);

  // ── Cmd+K keyboard shortcut for search panel ──────────────────────────────
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

  return (
    <div className="flex flex-col min-h-screen gradient-bg">
      {/* ── Hero / Landing Section ─────────────────────────────────────── */}
      <header className="flex flex-col items-center justify-center px-6 pt-20 pb-12">
        {/* Logo / Brand */}
        <div className="flex items-center gap-3 mb-6 animate-float">
          <div className="relative">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
              </svg>
            </div>
            <div className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-green-400 border-2 border-background" />
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
            <span className="text-foreground">Code</span>
            <span className="text-primary">Map</span>
            <span className="text-accent ml-1 text-lg font-medium">AI</span>
          </h1>
        </div>

        {/* Tagline */}
        <p className="text-muted text-center text-lg max-w-xl mb-2">
          Paste a GitHub URL. Get an interactive visual map of the entire
          codebase.
        </p>
        <p className="text-muted/60 text-center text-sm max-w-md mb-10">
          File dependencies · Function calls · Architecture — all
          deterministic, no AI guessing.
        </p>

        {/* Input */}
        <InputBar
          onSubmit={handleSubmit}
          isLoading={isLoading}
          error={submitError || (status === "failed" ? pollError : null)}
        />

        {/* Progress */}
        {(status === "processing" ||
          status === "queued" ||
          status === "delayed") && (
            <ProgressBar
              progress={progress}
              step={step}
              status={status}
              position={position}
            />
          )}

        {/* Completed progress */}
        {status === "done" && (
          <ProgressBar progress={100} step="done" status="done" position={0} />
        )}
      </header>

      {/* ── Feature Cards (shown when idle) ────────────────────────────── */}
      {status === "idle" && (
        <section className="max-w-5xl mx-auto px-6 pb-20 w-full">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <FeatureCard
              icon={
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
                </svg>
              }
              title="File Dependencies"
              description="See every import relationship as a visual edge. Understand how files connect at a glance."
            />
            <FeatureCard
              icon={
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M8 3H5a2 2 0 00-2 2v3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M16 21h3a2 2 0 002-2v-3" />
                  <circle cx="12" cy="12" r="4" />
                </svg>
              }
              title="Function Call Graph"
              description="Click any file to drill down into its functions. See who calls what, with arrows showing direction."
            />
            <FeatureCard
              icon={
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                </svg>
              }
              title="One-Click GitHub"
              description="Every function links directly to its exact lines on GitHub. No hunting through code."
            />
          </div>

          {/* How it works */}
          <div className="mt-16 text-center">
            <h2 className="text-xl font-semibold text-foreground mb-8">
              How it works
            </h2>
            <div className="flex flex-col md:flex-row items-center justify-center gap-6 text-sm">
              <Step num={1} text="Paste a GitHub repo URL" />
              <Arrow />
              <Step num={2} text="We download & parse every file" />
              <Arrow />
              <Step num={3} text="Explore the interactive graph" />
            </div>
          </div>
        </section>
      )}

      {/* ── Graph Section (shown when analysis is complete) ─────────────── */}
      {isDone && fileGraph && (
        <section className="flex-1 px-6 pb-12">
          <StatsBar stats={fileGraph.stats} owner={owner} repo={repo} />

          <div className="max-w-[1600px] mx-auto">
            {/* Graph controls */}
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
            />

            {/* Conditional graph rendering */}
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
                className="flex items-center justify-center rounded-2xl"
                style={{
                  height: "75vh",
                  background: "#0d1117",
                  border: "1px solid #30363d",
                  color: "#484f58",
                }}
              >
                <div className="text-center">
                  <p className="text-lg mb-2">No function selected</p>
                  <p className="text-sm">
                    Click a file in the graph, then click a function to see its
                    call graph.
                  </p>
                  <button
                    onClick={handleBackToFileGraph}
                    className="mt-4 px-4 py-2 rounded-lg text-sm"
                    style={{
                      background: "#1c2128",
                      border: "1px solid #30363d",
                      color: "#8b949e",
                    }}
                  >
                    Back to file graph
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* New analysis button */}
          <div className="text-center mt-6">
            <button
              id="new-analysis-btn"
              onClick={handleReset}
              className="text-sm text-muted hover:text-foreground transition-colors underline underline-offset-4"
            >
              Analyze another repository
            </button>
          </div>
        </section>
      )}

      {/* ── Details Panel (slides in on file click) ────────────────────── */}
      {isDone && fileGraph && (
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
        />
      )}

      {/* ── Search Panel (sidebar overlay) ──────────────────────────────── */}
      {isDone && fileGraph && (
        <SearchPanel
          isOpen={searchPanelOpen}
          onClose={() => setSearchPanelOpen(false)}
          owner={owner}
          repo={repo}
          onSelectFile={(filePath) => {
            const file = fileGraph.files.find((f) => f.id === filePath);
            if (file) {
              setSelectedFile(file);
              setSearchPanelOpen(false);
            }
          }}
        />
      )}

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className="py-6 text-center text-xs text-muted/40 border-t border-border/30">
        CodeMap AI · Deterministic codebase analysis · No AI hallucinations
      </footer>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div
      className="group rounded-2xl border border-border bg-surface p-6 transition-all duration-300
                    hover:border-primary/20 hover:shadow-lg hover:shadow-primary/5"
    >
      <div
        className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary mb-4
                      group-hover:bg-primary/15 transition-colors"
      >
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-foreground mb-2">{title}</h3>
      <p className="text-sm text-muted leading-relaxed">{description}</p>
    </div>
  );
}

function Step({ num, text }: { num: number; text: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-8 h-8 rounded-full bg-primary/10 text-primary font-bold text-sm flex items-center justify-center">
        {num}
      </div>
      <span className="text-muted">{text}</span>
    </div>
  );
}

function Arrow() {
  return (
    <svg
      className="hidden md:block text-border"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );
}
