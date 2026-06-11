"use client";

interface ProgressBarProps {
  progress: number;
  step: string;
  status: string;
  position: number;
}

// Pipeline stages in order. Each stage owns a percent range — the active
// stage is derived from the live progress/step coming from the backend.
const STAGES: { key: string; label: string; from: number }[] = [
  { key: "metadata", label: "Fetching metadata", from: 0 },
  { key: "download", label: "Downloading repo", from: 10 },
  { key: "extract", label: "Extracting files", from: 25 },
  { key: "classify", label: "Classifying files", from: 30 },
  { key: "parse", label: "Parsing source", from: 50 },
  { key: "graph", label: "Building graph", from: 75 },
  { key: "store", label: "Storing results", from: 85 },
];

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export default function ProgressBar({ progress, step, status, position }: ProgressBarProps) {
  if (status === "queued" || status === "delayed") {
    return (
      <div className="w-full max-w-2xl mx-auto mt-8 animate-in fade-in">
        <div className="bg-surface border border-border rounded-2xl p-6 text-center">
          <div className="flex items-center justify-center gap-3 mb-3">
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
  // index of the stage we're currently inside
  let activeIdx = 0;
  for (let i = 0; i < STAGES.length; i++) {
    if (progress >= STAGES[i].from) activeIdx = i;
  }
  if (isDone) activeIdx = STAGES.length;

  // live detail, e.g. "parsing files (380/1240)"
  const detail = step && step !== "processing" ? step : "";

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

        {/* Stage list */}
        <ol className="space-y-2">
          {STAGES.map((s, i) => {
            const stageDone = isDone || i < activeIdx;
            const stageActive = !isDone && i === activeIdx;
            return (
              <li key={s.key} className="flex items-center gap-3 text-sm">
                <span
                  className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 transition-colors ${
                    stageDone
                      ? "bg-green-500/20 text-green-400"
                      : stageActive
                        ? "bg-primary/20 text-primary"
                        : "bg-background text-muted/40"
                  }`}
                >
                  {stageDone ? (
                    <CheckIcon />
                  ) : stageActive ? (
                    <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-current" />
                  )}
                </span>
                <span
                  className={
                    stageDone ? "text-muted line-through decoration-muted/30" : stageActive ? "text-foreground font-medium" : "text-muted/50"
                  }
                >
                  {s.label}
                </span>
                {stageActive && detail && (
                  <span className="text-xs text-muted font-mono truncate max-w-[16rem]">{detail}</span>
                )}
              </li>
            );
          })}
        </ol>

        {isDone && (
          <div className="mt-4 flex items-center gap-2 text-sm text-green-400">
            <CheckIcon />
            Opening the graph…
          </div>
        )}
      </div>
    </div>
  );
}
