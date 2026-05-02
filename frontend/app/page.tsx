"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import InputBar from "./components/InputBar";
import ProgressBar from "./components/ProgressBar";
import { useJobPolling } from "./hooks/useJobPolling";
import { submitAnalysis } from "./lib/client";

export default function Home() {
  const router = useRouter();
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

  const isLoading =
    status === "submitting" ||
    status === "processing" ||
    status === "queued" ||
    status === "delayed";

  // ── Navigate to /repo on completion ─────────────────────────────────────────
  useEffect(() => {
    if (status === "done" && result?._inlineFileGraph) {
      try {
        sessionStorage.setItem("codemap-result", JSON.stringify(result));
      } catch {}
      const owner = result.owner || "";
      const repo = result.repo || "";
      router.push(`/repo?repo=${owner}/${repo}`);
    }
  }, [status, result, router]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (repoUrl: string) => {
      setSubmitError(null);
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

  const handleReset = useCallback(() => {
    reset();
    setSubmitError(null);
  }, [reset]);

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

        {/* Completed progress — shown briefly before redirect */}
        {status === "done" && (
          <ProgressBar progress={100} step="done" status="done" position={0} />
        )}
      </header>

      {/* ── Feature Cards (shown when idle or failed) ──────────────────── */}
      {(status === "idle" || status === "failed") && (
        <section className="max-w-5xl mx-auto px-6 pb-20 w-full">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <FeatureCard
              icon={
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
                </svg>
              }
              title="File Dependencies"
              description="See every import relationship as a visual edge. Understand how files connect at a glance."
            />
            <FeatureCard
              icon={
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M8 3H5a2 2 0 00-2 2v3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M16 21h3a2 2 0 002-2v-3" />
                  <circle cx="12" cy="12" r="4" />
                </svg>
              }
              title="Function Call Graph"
              description="Click any file to drill down into its functions. See who calls what, with arrows showing direction."
            />
            <FeatureCard
              icon={
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
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

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className="mt-auto py-6 text-center text-xs text-muted/40 border-t border-border/30">
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
