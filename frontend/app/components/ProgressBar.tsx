"use client";

interface ProgressBarProps {
  progress: number;
  step: string;
  status: string;
  position: number;
}

// Pipeline stages in order. Each stage owns a starting percent — the active
// stage is derived from the live progress coming from the backend.
const STAGES: { key: string; label: string; from: number }[] = [
  { key: "metadata", label: "Fetching metadata", from: 0 },
  { key: "download", label: "Downloading repository", from: 10 },
  { key: "extract", label: "Extracting files", from: 25 },
  { key: "classify", label: "Classifying files", from: 30 },
  { key: "parse", label: "Parsing source", from: 50 },
  { key: "graph", label: "Building graph", from: 75 },
  { key: "store", label: "Storing results", from: 85 },
];

export default function ProgressBar({ progress, step, status, position }: ProgressBarProps) {
  // ── Queued: single calm line ────────────────────────────────────────────────
  if (status === "queued" || status === "delayed") {
    return (
      <div className="w-full max-w-2xl mx-auto mt-8 animate-in fade-in">
        <div className="bg-surface border border-border rounded-2xl p-6 text-center">
          <div className="flex items-center justify-center gap-3 mb-2">
            <div className="flex gap-1">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse-dot" />
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse-dot" style={{ animationDelay: "0.3s" }} />
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse-dot" style={{ animationDelay: "0.6s" }} />
            </div>
            <span className="text-foreground font-medium">Queued</span>
          </div>
          {position > 0 && (
            <p className="text-muted text-sm">
              You are <span className="text-primary font-mono font-semibold">#{position}</span> in queue
            </p>
          )}
        </div>
      </div>
    );
  }

  const isDone = status === "done";

  // Which stage are we inside, based on live progress?
  let activeIdx = 0;
  for (let i = 0; i < STAGES.length; i++) {
    if (progress >= STAGES[i].from) activeIdx = i;
  }

  // Live detail from the backend, e.g. "parsing files (380/1240)".
  const detail = step && step !== "processing" && step !== "Starting..." ? step : "";
  const label = isDone ? "Analysis complete" : STAGES[activeIdx].label;
  // key changes whenever the line text changes → re-mounts → fade animation.
  const lineKey = isDone ? "done" : `${activeIdx}|${detail}`;

  return (
    <div className="w-full max-w-2xl mx-auto mt-8 animate-in fade-in">
      <div className="bg-surface border border-border rounded-2xl p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm text-foreground font-medium">
            {isDone ? "Analysis complete!" : "Analyzing repository"}
          </span>
          <span className="text-sm font-mono text-muted">{Math.round(progress)}%</span>
        </div>

        {/* Bar */}
        <div className="h-2 bg-background rounded-full overflow-hidden mb-5">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary to-accent progress-fill relative"
            style={{ width: `${Math.max(2, progress)}%` }}
          >
            <div className="absolute inset-0 progress-shimmer" />
          </div>
        </div>

        {/* Single animated status line (ChatGPT-style) — replaces the old checklist */}
        <div className="flex items-center gap-2.5 text-sm min-h-[22px]">
          {isDone ? (
            <span className="w-4 h-4 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center flex-shrink-0">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </span>
          ) : (
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse-dot flex-shrink-0" />
          )}

          <span
            key={lineKey}
            className="animate-in fade-in slide-in-from-bottom-1 duration-300 flex items-baseline gap-2 min-w-0"
          >
            <span className={isDone ? "text-green-400 font-medium" : "text-foreground font-medium"}>
              {label}
            </span>
            {detail && !isDone && (
              <span className="text-xs text-muted font-mono truncate max-w-[18rem]">{detail}</span>
            )}
          </span>
        </div>

        {isDone && (
          <p className="mt-3 text-xs text-muted">Opening the graph…</p>
        )}
      </div>
    </div>
  );
}
