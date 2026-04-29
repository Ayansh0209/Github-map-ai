"use client";

import type { FileNodeDTO, ImportEdgeDTO } from "../lib/client";

interface DetailsPanelProps {
  file: FileNodeDTO | null;
  edges: ImportEdgeDTO[];
  owner: string;
  repo: string;
  commitSha: string;
  onClose: () => void;
  onFileNavigate: (fileId: string) => void;
}

export default function DetailsPanel({
  file,
  edges,
  owner,
  repo,
  commitSha,
  onClose,
  onFileNavigate,
}: DetailsPanelProps) {
  if (!file) return null;

  // imports FROM this file (outgoing)
  const outgoing = edges.filter((e) => e.source === file.id);
  // imports INTO this file (incoming)
  const incoming = edges.filter((e) => e.target === file.id);

  const githubUrl = `https://github.com/${owner}/${repo}/blob/${commitSha}/${file.path}`;

  return (
    <div className="fixed right-0 top-0 h-full w-96 bg-surface border-l border-border z-40
                    overflow-y-auto animate-in slide-in-from-right duration-300 shadow-2xl">
      {/* Header */}
      <div className="sticky top-0 bg-surface/95 backdrop-blur border-b border-border p-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-mono font-semibold text-foreground truncate">
            {file.label}
          </h3>
          <p className="text-xs text-muted mt-0.5 truncate">{file.path}</p>
        </div>
        <button
          id="details-close-btn"
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-surface-hover text-muted hover:text-foreground transition-colors shrink-0"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="p-4 space-y-5">
        {/* File info */}
        <section>
          <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">File Info</h4>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <InfoRow label="Language" value={file.language} />
            <InfoRow label="Kind" value={file.kind} />
            <InfoRow label="Lines" value={file.lineCount.toString()} />
            <InfoRow label="Size" value={`${(file.sizeBytes / 1024).toFixed(1)}KB`} />
            <InfoRow label="Status" value={file.parseStatus} />
            <InfoRow label="Entry point" value={file.isEntryPoint ? "Yes" : "No"} />
          </div>
        </section>

        {/* Imports outgoing */}
        <section>
          <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
            Imports ({outgoing.length})
          </h4>
          {outgoing.length === 0 ? (
            <p className="text-sm text-muted/60 italic">No imports</p>
          ) : (
            <ul className="space-y-1">
              {outgoing.map((e, i) => (
                <li key={i}>
                  <button
                    className="w-full text-left text-sm py-1.5 px-2 rounded-lg hover:bg-surface-hover
                               transition-colors text-foreground/80 hover:text-foreground flex items-center gap-2"
                    onClick={() => onFileNavigate(e.target)}
                  >
                    <span className="text-primary">→</span>
                    <span className="font-mono text-xs truncate">{e.target}</span>
                    {e.isTypeOnly && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400">type</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Imported by */}
        <section>
          <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
            Imported By ({incoming.length})
          </h4>
          {incoming.length === 0 ? (
            <p className="text-sm text-muted/60 italic">Not imported by any file</p>
          ) : (
            <ul className="space-y-1">
              {incoming.map((e, i) => (
                <li key={i}>
                  <button
                    className="w-full text-left text-sm py-1.5 px-2 rounded-lg hover:bg-surface-hover
                               transition-colors text-foreground/80 hover:text-foreground flex items-center gap-2"
                    onClick={() => onFileNavigate(e.source)}
                  >
                    <span className="text-accent">←</span>
                    <span className="font-mono text-xs truncate">{e.source}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* External imports */}
        {file.externalImports.length > 0 && (
          <section>
            <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
              External Deps ({file.externalImports.length})
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {file.externalImports.map((dep, i) => (
                <span
                  key={i}
                  className="text-xs px-2 py-1 rounded-md bg-surface-hover text-muted font-mono"
                >
                  {dep}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* GitHub link */}
        <section>
          <a
            id="github-link"
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl
                       bg-surface-hover border border-border text-sm font-medium
                       hover:border-primary/40 hover:text-primary transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            View on GitHub
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
            </svg>
          </a>
        </section>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-1.5 px-2 rounded-lg bg-background">
      <div className="text-[10px] text-muted uppercase tracking-wider">{label}</div>
      <div className="text-sm font-medium text-foreground/90 mt-0.5">{value}</div>
    </div>
  );
}
