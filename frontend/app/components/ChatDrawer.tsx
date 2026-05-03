"use client";

import { useState, useRef, useEffect, useCallback } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

interface ChatMessage {
  role: "user" | "model";
  content: string;
}

interface ChatDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  owner: string;
  repo: string;
  commitSha: string;
  issueNumber: number;
  fileId: string;
  fileName: string;
  connectedFileIds: string[];
}

// ── Parse markdown code blocks ───────────────────────────────────────────────
function renderMessageContent(content: string) {
  const parts: Array<{ type: "text" | "code"; content: string; lang?: string }> = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", content: content.slice(lastIndex, match.index) });
    }
    parts.push({ type: "code", content: match[2], lang: match[1] || "text" });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    parts.push({ type: "text", content: content.slice(lastIndex) });
  }

  return (
    <>
      {parts.map((part, i) => {
        if (part.type === "code") {
          return (
            <div key={i} className="relative group">
              <pre className="text-xs overflow-x-auto">
                <code>{part.content}</code>
              </pre>
              <button
                className="absolute top-2 right-2 text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ background: "#21262d", color: "#8b949e", border: "1px solid #30363d" }}
                onClick={() => navigator.clipboard.writeText(part.content)}
              >
                Copy
              </button>
            </div>
          );
        }
        return <span key={i} style={{ whiteSpace: "pre-wrap" }}>{part.content}</span>;
      })}
    </>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function ChatDrawer({
  isOpen,
  onClose,
  owner,
  repo,
  commitSha,
  issueNumber,
  fileId,
  fileName,
  connectedFileIds,
}: ChatDrawerProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [isOpen]);

  // Reset on file change
  useEffect(() => {
    setMessages([]);
    setInput("");
  }, [fileId]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isStreaming) return;

    const userMsg: ChatMessage = { role: "user", content: text.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setIsStreaming(true);

    try {
      const res = await fetch(`${API_BASE}/issue-map/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner,
          repo,
          commitSha,
          issueNumber,
          fileId,
          connectedFileIds: connectedFileIds.slice(0, 5),
          messages: newMessages,
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let aiContent = "";

      // Add placeholder AI message
      setMessages(prev => [...prev, { role: "model", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") break;
            try {
              const text = JSON.parse(data);
              aiContent += text;
              setMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: "model", content: aiContent };
                return updated;
              });
            } catch {
              // Not JSON, append raw
              aiContent += data;
              setMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: "model", content: aiContent };
                return updated;
              });
            }
          }
        }
      }
    } catch (err) {
      setMessages(prev => [
        ...prev,
        { role: "model", content: `⚠️ Error: ${(err as Error).message}. Please try again.` },
      ]);
    } finally {
      setIsStreaming(false);
    }
  }, [messages, isStreaming, owner, repo, commitSha, issueNumber, fileId, connectedFileIds]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const suggestedQuestions = [
    "What does this file do?",
    "Where should I make changes for this issue?",
    "Show me the fix",
  ];

  if (!isOpen) return null;

  return (
    <div
      className="fixed bottom-0 right-0 z-50 animate-slide-up flex flex-col"
      style={{
        width: "380px",
        height: "50vh",
        background: "#0d1117",
        borderTop: "1px solid #30363d",
        borderLeft: "1px solid #30363d",
        borderTopLeftRadius: "16px",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: "1px solid #21262d" }}
      >
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: "rgba(168,85,247,0.15)" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#a855f7" strokeWidth="2">
              <path d="M12 2a10 10 0 1 0 10 10H12V2Z" />
              <path d="M12 12l8.5-5" />
            </svg>
          </div>
          <span className="text-xs font-semibold" style={{ color: "#e6edf3" }}>AI Chat</span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-lg transition-colors"
          style={{ color: "#8b949e" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Context notice */}
      <div className="px-4 py-2 text-[11px] shrink-0" style={{ color: "#484f58", borderBottom: "1px solid #21262d" }}>
        Asking about <span style={{ color: "#8b949e", fontFamily: "var(--font-geist-mono), monospace" }}>{fileName}</span> in context of issue <span style={{ color: "#f97316" }}>#{issueNumber}</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <p className="text-xs text-center" style={{ color: "#484f58" }}>
              Ask anything about this file and the issue
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {suggestedQuestions.map((q, i) => (
                <button
                  key={i}
                  onClick={() => sendMessage(q)}
                  className="text-[11px] px-3 py-1.5 rounded-full transition-colors"
                  style={{ background: "#161b22", border: "1px solid #30363d", color: "#58a6ff" }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] px-3 py-2 text-xs ${msg.role === "user" ? "chat-bubble-user" : "chat-bubble-ai"}`}
              >
                {msg.role === "model" ? renderMessageContent(msg.content) : msg.content}
                {msg.role === "model" && msg.content === "" && isStreaming && (
                  <span className="inline-block w-2 h-4 ml-1 animate-pulse" style={{ background: "#8b949e", borderRadius: 1 }} />
                )}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3 shrink-0" style={{ borderTop: "1px solid #21262d" }}>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about this file..."
            disabled={isStreaming}
            className="flex-1 px-3 py-2 rounded-lg text-xs outline-none"
            style={{
              background: "#161b22",
              border: "1px solid #30363d",
              color: "#e6edf3",
              fontFamily: "var(--font-geist-mono), monospace",
            }}
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={isStreaming || !input.trim()}
            className="px-3 py-2 rounded-lg text-xs font-semibold transition-all disabled:opacity-30"
            style={{ background: "rgba(168,85,247,0.15)", color: "#a855f7", border: "1px solid rgba(168,85,247,0.3)" }}
          >
            {isStreaming ? (
              <span className="inline-block w-3 h-3 border-2 rounded-full animate-spin" style={{ borderColor: "#a855f7", borderTopColor: "transparent" }} />
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
