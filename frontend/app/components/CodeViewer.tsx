"use client";

import { useRef, useEffect, useMemo, useState } from "react";
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
  highlightLines?: [number, number] | null;
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
  title,
  maxHeight = "500px",
}: CodeViewerProps) {
  const lang = language || detectLanguage(filePath);
  const allLines = useMemo(() => code.split("\n"), [code]);

  // Highlight with hljs
  const highlighted = useMemo(() => {
    try {
      const result = hljs.highlight(allLines.join("\n"), { language: lang });
      return result.value;
    } catch {
      // Fallback: escape HTML
      return allLines.join("\n")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }
  }, [allLines, lang]);

  // Split highlighted HTML back into lines
  const highlightedLines = useMemo(() => {
    return highlighted.split("\n");
  }, [highlighted]);

  // Virtual scrolling state
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [fontSize, setFontSize] = useState(12);
  const ITEM_HEIGHT = Math.round(fontSize * 1.6); // line-height is 1.6

  // Auto-scroll to highlighted lines
  useEffect(() => {
    if (highlightLines && containerRef.current) {
      const targetY = (highlightLines[0] - 1) * ITEM_HEIGHT;
      containerRef.current.scrollTo({ top: targetY, behavior: "smooth" });
    }
  }, [highlightLines, ITEM_HEIGHT]);

  const handleLineClick = (lineNum: number) => {
    const filename = filePath.split("/").pop() || filePath;
    navigator.clipboard.writeText(`${filename}:${lineNum}`).catch(() => {});
  };

  return (
    <div className="rounded-xl overflow-hidden flex flex-col h-full" style={{ background: "#0d1117", border: "1px solid #30363d" }}>
      {/* Title bar */}
      {title && (
        <div
          className="flex items-center justify-between px-3 py-2 text-xs font-medium"
          style={{ background: "#161b22", borderBottom: "1px solid #21262d", color: "#8b949e" }}
        >
          <div className="flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
            </svg>
            <span style={{ fontFamily: "var(--font-geist-mono), monospace" }}>{title}</span>
          </div>
          <div className="flex items-center gap-1">
            <button 
              onClick={() => setFontSize(f => Math.max(8, f - 1))}
              className="w-5 h-5 rounded flex items-center justify-center hover:bg-white/10 transition-colors"
              title="Decrease font size"
            >
              -
            </button>
            <span className="w-4 text-center">{fontSize}</span>
            <button 
              onClick={() => setFontSize(f => Math.min(24, f + 1))}
              className="w-5 h-5 rounded flex items-center justify-center hover:bg-white/10 transition-colors"
              title="Increase font size"
            >
              +
            </button>
          </div>
        </div>
      )}

      {/* Code area with virtual scroll */}
      <div
        ref={containerRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="code-viewer flex-1"
        style={{ overflowY: "auto", scrollbarWidth: "none", msOverflowStyle: "none" }}
      >
        <style dangerouslySetInnerHTML={{ __html: `
          .code-viewer::-webkit-scrollbar { display: none; }
        `}} />
        <div style={{ height: allLines.length * ITEM_HEIGHT, position: "relative" }}>
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 10) * ITEM_HEIGHT}px)`
            }}
            className="py-2"
          >
            {highlightedLines
              .slice(
                Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 10),
                Math.min(allLines.length, Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 10) + Math.max(Math.ceil((containerRef.current?.clientHeight || 800) / ITEM_HEIGHT), 50) + 20)
              )
              .map((html, idx) => {
                const lineNum = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 10) + idx + 1;
                const isHighlighted = highlightLines
                  ? lineNum >= highlightLines[0] && lineNum <= highlightLines[1]
                  : false;

                return (
                  <div
                    key={lineNum}
                    data-line={lineNum}
                    className={`flex ${isHighlighted ? "line-highlight" : ""}`}
                    style={{ height: `${ITEM_HEIGHT}px`, paddingRight: "16px", lineHeight: `${ITEM_HEIGHT}px` }}
                  >
                    <span
                      className="line-number inline-block w-12 text-right pr-4 shrink-0 cursor-pointer hover:text-gray-300 select-none"
                      style={{ color: "#484f58", fontSize: `${fontSize}px` }}
                      onClick={() => handleLineClick(lineNum)}
                      title={`Click to copy ${filePath.split("/").pop()}:${lineNum}`}
                    >
                      {lineNum}
                    </span>
                    <span
                      className="flex-1 whitespace-pre"
                      style={{ color: "#e6edf3", fontSize: `${fontSize}px` }}
                      dangerouslySetInnerHTML={{ __html: html || " " }}
                    />
                  </div>
                );
              })}
          </div>
        </div>
      </div>
    </div>
  );
}
