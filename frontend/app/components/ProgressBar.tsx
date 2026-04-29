"use client";

interface ProgressBarProps {
  progress: number;
  step: string;
  status: string;
  position: number;
}

const STEP_LABELS: Record<string, string> = {
  starting: "Starting analysis...",
  "fetching repository metadata": "Fetching repository metadata...",
  "downloading repository": "Downloading repository...",
  "extracting files": "Extracting files...",
  "walking file tree": "Walking file tree...",
  "filtering and classifying files": "Filtering files...",
  "parsing files": "Parsing source files...",
  "building graph": "Building dependency graph...",
  "graph built": "Almost done...",
  done: "Analysis complete!",
  "done (from cache)": "Loaded from cache!",
};

export default function ProgressBar({
  progress,
  step,
  status,
  position,
}: ProgressBarProps) {
  const label = STEP_LABELS[step] || step || "Working...";

  if (status === "queued" || status === "delayed") {
    return (
      <div className="w-full max-w-2xl mx-auto mt-8 animate-in fade-in">
        <div className="bg-surface border border-border rounded-2xl p-6 text-center">
          <div className="flex items-center justify-center gap-3 mb-3">
            <div className="flex gap-1">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse-dot" />
              <span
                className="w-2 h-2 rounded-full bg-primary animate-pulse-dot"
                style={{ animationDelay: "0.3s" }}
              />
              <span
                className="w-2 h-2 rounded-full bg-primary animate-pulse-dot"
                style={{ animationDelay: "0.6s" }}
              />
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

  return (
    <div className="w-full max-w-2xl mx-auto mt-8 animate-in fade-in">
      <div className="bg-surface border border-border rounded-2xl p-6">
        {/* Step label */}
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm text-foreground font-medium">{label}</span>
          <span className="text-sm font-mono text-muted">{Math.round(progress)}%</span>
        </div>

        {/* Bar */}
        <div className="h-2 bg-background rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary to-accent progress-fill relative"
            style={{ width: `${Math.max(2, progress)}%` }}
          >
            {/* Shimmer overlay */}
            <div className="absolute inset-0 progress-shimmer" />
          </div>
        </div>

        {/* Sub-step info */}
        {status === "done" && (
          <div className="mt-4 flex items-center gap-2 text-sm text-green-400">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            Analysis complete — scroll down to explore
          </div>
        )}
      </div>
    </div>
  );
}
