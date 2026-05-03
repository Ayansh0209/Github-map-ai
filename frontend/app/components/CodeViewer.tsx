"use client";

import { useRef, useEffect, useMemo } from "react";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import "highlight.js/styles/github-dark.css";

// Register languages once
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("jsx", javascript);

interface CodeViewerProps {
  code: string;
  filePath: string;
  language?: string;
  highlightLines?: [number, number] | null; // [startLine, endLine]
  maxLines?: number; // initial lines to show
  onLoadMore?: () => void;
  hasMore?: boolean;
  title?: string;
  maxHeight?: string;
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    html: "xml", css: "css", json: "json",
  };
  return map[ext] || "typescript";
}

export default function CodeViewer({
  code,
  filePath,
  language,
  highlightLines = null,
  maxLines = 200,
  onLoadMore,
  hasMore = false,
  title,
  maxHeight = "500px",
}: CodeViewerProps) {
  const codeRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  const lang = language || detectLanguage(filePath);
  const allLines = useMemo(() => code.split("\n"), [code]);
  const displayLines = allLines.slice(0, maxLines);

  // Highlight with hljs
  const highlighted = useMemo(() => {
    try {
      const result = hljs.highlight(displayLines.join("\n"), { language: lang });
      return result.value;
    } catch {
      // Fallback: escape HTML
      return displayLines.join("\n")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }
  }, [displayLines, lang]);

  // Split highlighted HTML back into lines (preserving tags)
  const highlightedLines = useMemo(() => {
    // Split on newlines but preserve the HTML tags across lines
    return highlighted.split("\n");
  }, [highlighted]);

  // Auto-scroll to highlighted lines
  useEffect(() => {
    if (highlightLines && highlightRef.current) {
      const targetLine = highlightRef.current.querySelector(`[data-line="${highlightLines[0]}"]`);
      if (targetLine) {
        targetLine.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [highlightLines, highlighted]);

  const handleLineClick = (lineNum: number) => {
    const filename = filePath.split("/").pop() || filePath;
    navigator.clipboard.writeText(`${filename}:${lineNum}`).catch(() => {});
  };

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: "#0d1117", border: "1px solid #30363d" }}>
      {/* Title bar */}
      {title && (
        <div
          className="flex items-center gap-2 px-3 py-2 text-xs font-medium"
          style={{ background: "#161b22", borderBottom: "1px solid #21262d", color: "#8b949e" }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
          </svg>
          <span style={{ fontFamily: "var(--font-geist-mono), monospace" }}>{title}</span>
        </div>
      )}

      {/* Code area */}
      <div
        ref={highlightRef}
        className="code-viewer overflow-auto"
        style={{ maxHeight }}
      >
        <div ref={codeRef} className="py-2">
          {highlightedLines.map((html, i) => {
            const lineNum = i + 1;
            const isHighlighted = highlightLines
              ? lineNum >= highlightLines[0] && lineNum <= highlightLines[1]
              : false;

            return (
              <div
                key={lineNum}
                data-line={lineNum}
                className={`flex ${isHighlighted ? "line-highlight" : ""}`}
                style={{ minHeight: "19px", paddingRight: "16px" }}
              >
                <span
                  className="line-number"
                  onClick={() => handleLineClick(lineNum)}
                  title={`Click to copy ${filePath.split("/").pop()}:${lineNum}`}
                >
                  {lineNum}
                </span>
                <span
                  className="flex-1"
                  style={{ color: "#e6edf3", whiteSpace: "pre" }}
                  dangerouslySetInnerHTML={{ __html: html || " " }}
                />
              </div>
            );
          })}
        </div>

        {/* Load more */}
        {(hasMore || allLines.length > maxLines) && onLoadMore && (
          <div className="flex justify-center py-3" style={{ borderTop: "1px solid #21262d" }}>
            <button
              onClick={onLoadMore}
              className="text-xs px-4 py-1.5 rounded-lg transition-colors"
              style={{ background: "#161b22", border: "1px solid #30363d", color: "#58a6ff" }}
            >
              Load more ({allLines.length - maxLines} lines remaining)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
