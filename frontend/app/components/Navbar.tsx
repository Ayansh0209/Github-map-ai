"use client";

interface NavbarProps {
  owner: string;
  repo: string;
  onAnalyzeAnother: () => void;
}

export default function Navbar({ owner, repo, onAnalyzeAnother }: NavbarProps) {
  return (
    <nav
      className="flex items-center justify-between px-4 shrink-0"
      style={{
        height: "48px",
        background: "#0d1117",
        borderBottom: "1px solid #21262d",
      }}
    >
      {/* Left — Logo */}
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
          </svg>
        </div>
        <span className="text-sm font-bold" style={{ color: "#e6edf3" }}>
          <span>Code</span>
          <span style={{ color: "#6366f1" }}>Map</span>
          <span className="text-xs font-medium ml-0.5" style={{ color: "#a78bfa" }}>AI</span>
        </span>
      </div>

      {/* Center — Repo name */}
      <div className="flex items-center gap-2">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="#8b949e">
          <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1h-8a1 1 0 00-1 1v6.708A2.486 2.486 0 014.5 9h8V1.5z" />
        </svg>
        <span className="text-sm font-semibold" style={{ color: "#e6edf3", fontFamily: "var(--font-geist-mono), monospace" }}>
          {owner}/{repo}
        </span>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
          style={{ background: "rgba(63,185,80,0.15)", color: "#3fb950" }}
        >
          analyzed
        </span>
      </div>

      {/* Right — Back link */}
      <button
        onClick={onAnalyzeAnother}
        className="text-xs transition-colors hover:opacity-80 flex items-center gap-1.5"
        style={{ color: "#8b949e" }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Analyze another repo
      </button>
    </nav>
  );
}
