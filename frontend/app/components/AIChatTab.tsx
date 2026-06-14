"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface AIChatTabProps {
  owner: string;
  repo: string;
  commitSha: string;
  issueNumber: number | undefined;
  fileId: string;
  currentFileId: string;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
}

// ── Scoped keyframes (only what Tailwind can't express) ───────────────────────

const SCOPED_STYLES = `
@keyframes aichat-pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
@keyframes aichat-dots {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}
@keyframes aichat-fadein {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: translateY(0); }
}
.aichat-dot-1 { animation: aichat-dots 1.4s infinite 0s; }
.aichat-dot-2 { animation: aichat-dots 1.4s infinite 0.2s; }
.aichat-dot-3 { animation: aichat-dots 1.4s infinite 0.4s; }
`;

// ── Streaming phases ──────────────────────────────────────────────────────────

const STREAM_PHASES = [
  { label: "Analyzing issue...", icon: "🔍", durationMs: 600 },
  { label: "Retrieving context...", icon: "🗺️", durationMs: 800 },
  { label: "Ranking files...", icon: "📊", durationMs: 600 },
  { label: "Generating...", icon: "✨", durationMs: 0 },
] as const;

// ── Collapsible code block ────────────────────────────────────────────────────

function CodeBlock({ children, language }: { children?: React.ReactNode; language: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = typeof children === "string" ? children : "";
  const lineCount = text.split("\n").length;

  const highlighted = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      try { return hljs.highlight(text, { language }).value; } catch (_) {}
    }
    return hljs.highlightAuto(text).value;
  }, [text, language]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className="my-2 rounded-lg overflow-hidden transition-colors"
      style={{ border: "1px solid #30363d", background: "#0d1117" }}
    >
      {/* Header — click to expand/collapse */}
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer select-none transition-colors hover:bg-[#1c2128]"
        style={{ background: "#161b22", borderBottom: expanded ? "1px solid #30363d" : "none" }}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-1.5">
          <svg
            width="10" height="10" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2"
            className="transition-transform duration-200"
            style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", color: "#484f58" }}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
          <span className="text-[11px] font-mono" style={{ color: "#8b949e" }}>
            {language || "code"}
          </span>
          <span className="text-[10px]" style={{ color: "#484f58" }}>
            · {lineCount}L
          </span>
        </div>
        <button
          onClick={handleCopy}
          className="text-[10px] px-1.5 py-0.5 rounded transition-colors hover:text-white"
          style={{ color: "#8b949e" }}
        >
          {copied ? "✓" : "Copy"}
        </button>
      </div>

      {/* Body — collapsible */}
      <div
        className="overflow-hidden transition-all duration-300"
        style={{ maxHeight: expanded ? "350px" : "0px", overflowY: expanded ? "auto" : "hidden" }}
      >
        <pre className="p-3 m-0 text-[11px] leading-relaxed font-mono" style={{ color: "#e6edf3" }}>
          <code
            className={`hljs ${language}`}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        </pre>
      </div>
    </div>
  );
}

// ── MarkdownCode renderer ─────────────────────────────────────────────────────

function MarkdownCode({ className, children, ...props }: any) {
  const match = /language-(\w+)/.exec(className || "");
  const isInline = !match;
  if (isInline) {
    return (
      <code
        className="text-[12px] px-1 py-0.5 rounded font-mono"
        style={{ background: "rgba(110,118,129,0.2)" }}
        {...props}
      >
        {children}
      </code>
    );
  }
  return <CodeBlock language={match[1]}>{children}</CodeBlock>;
}

// ── Streaming indicator ───────────────────────────────────────────────────────

function StreamingIndicator({ phase }: { phase: number }) {
  // Single animated line (ChatGPT-style): one chip whose label fades as the
  // phase advances, instead of a stacked checklist.
  const idx = Math.min(Math.max(phase, 0), STREAM_PHASES.length - 1);
  const p = STREAM_PHASES[idx];
  return (
    <div className="flex justify-start">
      <div
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px]"
        style={{
          background: "rgba(99,102,241,0.08)",
          border: "1px solid rgba(99,102,241,0.2)",
          color: "#e6edf3",
        }}
      >
        {/* key re-mounts on phase change → smooth fade between steps */}
        <span
          key={idx}
          className="flex items-center gap-1.5"
          style={{ animation: "aichat-fadein 0.25s ease-out" }}
        >
          <span className="text-[11px]">{p.icon}</span>
          <span>{p.label}</span>
        </span>
        <span className="flex gap-0.5 ml-1">
          <span className="aichat-dot-1 w-1 h-1 rounded-full bg-current inline-block" />
          <span className="aichat-dot-2 w-1 h-1 rounded-full bg-current inline-block" />
          <span className="aichat-dot-3 w-1 h-1 rounded-full bg-current inline-block" />
        </span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AIChatTab({
  owner,
  repo,
  commitSha,
  issueNumber,
  fileId,
  currentFileId,
  messages,
  setMessages,
  isLoading,
  setIsLoading,
}: AIChatTabProps) {
  const [input, setInput] = useState("");
  const [streamPhase, setStreamPhase] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileName = fileId.split("/").pop() || fileId;

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + "px";
    }
  }, [input]);

  // Advance streaming phases
  useEffect(() => {
    if (!isLoading) { setStreamPhase(0); return; }
    setStreamPhase(0);
    const timers: NodeJS.Timeout[] = [];
    let cumulative = 0;
    for (let i = 1; i < STREAM_PHASES.length; i++) {
      cumulative += STREAM_PHASES[i - 1].durationMs;
      const t = setTimeout(() => setStreamPhase(i), cumulative);
      timers.push(t);
    }
    return () => timers.forEach(clearTimeout);
  }, [isLoading]);

  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setIsLoading(true);

    try {
      const res = await fetch("http://localhost:5000/issue-map/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner, repo, commitSha, currentFileId, issueNumber,
          messages: [...messages, { role: "user", content: userMsg }],
        }),
      });

      if (!res.ok || !res.body) throw new Error("Failed to chat");

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let buffer = "";

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            const lines = part.split("\n");
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const dataStr = line.replace("data: ", "").trim();
                if (dataStr === "[DONE]") continue;
                try {
                  const content = JSON.parse(dataStr);
                  setMessages((prev) => {
                    const newMessages = [...prev];
                    const last = newMessages[newMessages.length - 1];
                    if (last && last.role === "assistant") {
                      last.content += content;
                    }
                    return newMessages;
                  });
                } catch (e) { /* ignore partial JSON */ }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(err);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, an error occurred." },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, messages, owner, repo, commitSha, currentFileId, issueNumber, setMessages, setIsLoading]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Scoped keyframes */}
      <style dangerouslySetInnerHTML={{ __html: SCOPED_STYLES }} />

      {/* ── Messages ─────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {/* Empty state */}
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center text-center py-8">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center mb-3"
              style={{ background: "linear-gradient(135deg, rgba(99,102,241,0.15), rgba(168,85,247,0.15))", border: "1px solid rgba(99,102,241,0.2)" }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <p className="text-sm font-medium mb-1" style={{ color: "#e6edf3" }}>
              Ask about <span style={{ color: "#818cf8" }}>{fileName}</span>
            </p>
            <p className="text-xs mb-4" style={{ color: "#484f58" }}>
              Context includes this file and the related issue.
            </p>

            {/* Quick suggestion chips */}
            <div className="flex flex-col gap-1.5 w-full">
              {["What does this file do?", "How to fix the issue?", "Side effects?"].map((s) => (
                <button
                  key={s}
                  onClick={() => { setInput(s); textareaRef.current?.focus(); }}
                  className="text-[11px] px-2.5 py-1.5 rounded-lg text-left transition-all hover:bg-[#1c2128] hover:border-[#484f58]"
                  style={{ color: "#8b949e", border: "1px solid #30363d", background: "#161b22" }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message list */}
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            style={{ animation: "aichat-fadein 0.2s ease-out" }}
          >
            {msg.role === "user" ? (
              /* User bubble */
              <div
                className="max-w-[88%] rounded-xl rounded-br-sm px-3 py-2 text-[13px]"
                style={{
                  background: "rgba(99,102,241,0.1)",
                  border: "1px solid rgba(99,102,241,0.2)",
                  color: "#e6edf3",
                }}
              >
                <div className="whitespace-pre-wrap">{msg.content}</div>
              </div>
            ) : (
              /* Assistant bubble */
              <div
                className="max-w-[95%] rounded-xl rounded-bl-sm px-3 py-2.5 text-[13px]"
                style={{
                  background: "#161b22",
                  border: "1px solid #21262d",
                  color: "#e6edf3",
                }}
              >
                <div
                  className="chat-prose"
                  style={{ maxWidth: "100%", overflowX: "hidden", wordBreak: "break-word", overflowWrap: "anywhere" }}
                >
                  <ReactMarkdown components={{ code: MarkdownCode }}>
                    {msg.content.replace(/\\n/g, "\n")}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Streaming indicator */}
        {isLoading && (messages.length === 0 || messages[messages.length - 1]?.role === "user" ||
          (messages[messages.length - 1]?.role === "assistant" && messages[messages.length - 1]?.content === "")) && (
          <StreamingIndicator phase={streamPhase} />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ── Input ────────────────────────────────────────────────── */}
      <div className="shrink-0 px-3 py-2.5" style={{ borderTop: "1px solid #21262d", background: "#161b22" }}>
        <form onSubmit={handleSubmit}>
          <div
            className="flex items-end gap-2 rounded-lg px-3 py-2 transition-all"
            style={{ background: "#0d1117", border: "1px solid #30363d" }}
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Ask about ${fileName}...`}
              disabled={isLoading}
              rows={1}
              className="flex-1 bg-transparent text-[13px] text-white resize-none outline-none disabled:opacity-50 placeholder:text-[#484f58]"
              style={{ maxHeight: "120px", lineHeight: "1.4" }}
            />
            <button
              type="submit"
              disabled={!input.trim() || isLoading}
              className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center transition-all disabled:opacity-30"
              style={{ background: input.trim() ? "#6366f1" : "#21262d", color: "#fff" }}
            >
              {isLoading ? (
                <span
                  className="inline-block w-3.5 h-3.5 border-2 rounded-full animate-spin"
                  style={{ borderColor: "#fff", borderTopColor: "transparent" }}
                />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
              )}
            </button>
          </div>
          <div className="flex items-center justify-between mt-1 px-0.5">
            <span className="text-[9px]" style={{ color: "#484f58" }}>
              ↵ send · ⇧↵ newline
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
