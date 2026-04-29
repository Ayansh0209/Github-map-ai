"use client";

import { useState, FormEvent } from "react";

interface InputBarProps {
  onSubmit: (repoUrl: string) => void;
  isLoading: boolean;
  error: string | null;
}

const GITHUB_REGEX = /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export default function InputBar({ onSubmit, isLoading, error }: InputBarProps) {
  const [url, setUrl] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);

    const trimmed = url.trim().replace(/\/+$/, ""); // strip trailing slashes
    if (!trimmed) {
      setLocalError("Please enter a GitHub URL");
      return;
    }
    if (!GITHUB_REGEX.test(trimmed)) {
      setLocalError("Must be a valid URL: https://github.com/{owner}/{repo}");
      return;
    }

    onSubmit(trimmed);
  }

  const displayError = localError || error;

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-2xl mx-auto">
      <div className="glow-border rounded-2xl bg-surface p-1.5 transition-all duration-300">
        <div className="flex items-center gap-2">
          {/* GitHub icon */}
          <div className="pl-4 text-muted">
            <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </div>

          <input
            id="repo-url-input"
            type="text"
            placeholder="https://github.com/owner/repo"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setLocalError(null);
            }}
            disabled={isLoading}
            className="flex-1 bg-transparent py-3.5 text-foreground placeholder:text-muted/60 outline-none font-mono text-sm"
            autoComplete="off"
            spellCheck={false}
          />

          <button
            id="analyze-button"
            type="submit"
            disabled={isLoading}
            className="px-6 py-2.5 rounded-xl bg-primary text-white font-medium text-sm
                       transition-all duration-200
                       hover:bg-primary-hover hover:shadow-lg hover:shadow-primary/20
                       active:scale-[0.97]
                       disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-none
                       flex items-center gap-2"
          >
            {isLoading ? (
              <>
                <svg
                  className="animate-spin h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Analyzing...
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                  <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                </svg>
                Analyze
              </>
            )}
          </button>
        </div>
      </div>

      {displayError && (
        <p className="mt-3 text-center text-sm text-red-400/90 animate-in fade-in">
          {displayError}
        </p>
      )}
    </form>
  );
}
