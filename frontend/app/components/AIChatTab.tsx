"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";

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
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
}

export default function AIChatTab({
  owner,
  repo,
  commitSha,
  issueNumber,
  fileId,
  messages,
  setMessages,
  isLoading,
  setIsLoading,
}: AIChatTabProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setIsLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner,
          repo,
          commitSha,
          issueNumber,
          fileId,
          messages: [...messages, { role: "user", content: userMsg }],
        }),
      });

      if (!res.ok || !res.body) throw new Error("Failed to chat");

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          setMessages((prev) => {
            const newMessages = [...prev];
            const last = newMessages[newMessages.length - 1];
            if (last.role === "assistant") {
              last.content += chunk;
            }
            return newMessages;
          });
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
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-sm" style={{ color: "#8b949e" }}>
            <p className="mb-2">Ask a question about <strong>{fileId.split("/").pop()}</strong></p>
            <p className="text-xs">Context will include this file and the related issue.</p>
          </div>
        )}
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className="max-w-[90%] rounded-xl px-3 py-2 text-sm"
              style={{
                background: msg.role === "user" ? "rgba(88,166,255,0.15)" : "#1c2128",
                border: `1px solid ${msg.role === "user" ? "rgba(88,166,255,0.3)" : "#30363d"}`,
                color: "#e6edf3",
              }}
            >
              {msg.role === "assistant" ? (
                <div className="prose prose-invert prose-sm max-w-none">
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
              ) : (
                <div className="whitespace-pre-wrap">{msg.content}</div>
              )}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="max-w-[90%] rounded-xl px-3 py-2 text-sm flex items-center gap-2" style={{ background: "#1c2128", border: "1px solid #30363d" }}>
              <span className="inline-block w-3 h-3 border-2 rounded-full animate-spin" style={{ borderColor: "#8b949e", borderTopColor: "transparent" }} />
              <span style={{ color: "#8b949e" }}>AI is thinking...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-4 border-t" style={{ borderColor: "#30363d", background: "#161b22" }}>
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about this file..."
            disabled={isLoading}
            className="flex-1 bg-transparent border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-50"
            style={{ borderColor: "#30363d" }}
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            style={{ background: "#238636", color: "#ffffff" }}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
