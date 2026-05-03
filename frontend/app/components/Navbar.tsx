"use client";

interface NavbarProps {
  owner: string;
  repo: string;
  onAnalyzeAnother: () => void;
}

import { useState, useEffect } from "react";
import { GITHUB_REPO_URL } from "../lib/constants";

export default function Navbar({ owner, repo, onAnalyzeAnother }: NavbarProps) {
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    const match = GITHUB_REPO_URL.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (match) {
      fetch(`https://api.github.com/repos/${match[1]}/${match[2]}`)
        .then(res => res.json())
        .then(data => {
          if (typeof data.stargazers_count === "number") {
            setStars(data.stargazers_count);
          }
        })
        .catch(() => {});
    }
  }, []);

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

      {/* Right — Actions & Links */}
      <div className="flex items-center gap-4">
        {/* GitHub CTA */}
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          title="Support CodeMap development"
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors hover:bg-[#21262d] border border-transparent hover:border-[#30363d]"
          style={{ color: "#e6edf3" }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.699-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
          </svg>
          <span>Star on GitHub</span>
          {stars !== null && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-[#161b22] border border-[#30363d] ml-1">
              <span style={{ color: "#e3b341" }}>★</span>
              {stars > 999 ? (stars / 1000).toFixed(1) + "k" : stars}
            </span>
          )}
        </a>

        {/* Theme Toggle Placeholder (Hidden for now) */}
        {/* <div className="hidden" id="theme-toggle-slot"></div> */}

        {/* Future Donate Slot (Hidden for now) */}
        {/* <div className="hidden" id="donate-slot"></div> */}

        <div className="w-px h-4 bg-[#30363d]" />

        {/* Analyze Another */}
        <button
          onClick={onAnalyzeAnother}
          className="text-xs transition-colors hover:text-[#e6edf3] flex items-center gap-1.5"
          style={{ color: "#8b949e" }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Analyze another repo
        </button>
      </div>
    </nav>
  );
}
