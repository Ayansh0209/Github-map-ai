"use client";

import { useState, useRef, useEffect } from "react";

interface FiltersDropdownProps {
  activeKinds: Set<string>;
  activeLanguages: Set<string>;
  onKindsChange: (kinds: Set<string>) => void;
  onLanguagesChange: (langs: Set<string>) => void;
}

const KINDS = [
  { id: "source", label: "Source" },
  { id: "test", label: "Tests" },
  { id: "config", label: "Config" },
  { id: "entry", label: "Entry Points" },
  { id: "ui", label: "UI" },
];

const LANGUAGES = [
  { id: "typescript", label: "TS" },
  { id: "javascript", label: "JS" },
  { id: "tsx", label: "TSX" },
  { id: "jsx", label: "JSX" },
];

export default function FiltersDropdown({
  activeKinds,
  activeLanguages,
  onKindsChange,
  onLanguagesChange,
}: FiltersDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const toggleKind = (id: string) => {
    const next = new Set(activeKinds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onKindsChange(next);
  };

  const toggleLanguage = (id: string) => {
    const next = new Set(activeLanguages);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onLanguagesChange(next);
  };

  const clearAll = () => {
    onKindsChange(new Set());
    onLanguagesChange(new Set());
  };

  const activeCount = activeKinds.size + activeLanguages.size;

  return (
    <div className="relative inline-block text-left" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors border"
        style={{
          background: isOpen || activeCount > 0 ? "rgba(88,166,255,0.15)" : "#161b22",
          color: isOpen || activeCount > 0 ? "#58a6ff" : "#8b949e",
          border: isOpen || activeCount > 0 ? "1px solid rgba(88,166,255,0.4)" : "1px solid #30363d",
          height: "32px"
        }}
      >
        <span>Filters {activeCount > 0 && `(${activeCount})`}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={{
            transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s"
          }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {isOpen && (
        <div
          className="absolute z-50 mt-2 w-56 rounded-xl shadow-xl overflow-hidden"
          style={{
            background: "#161b22",
            border: "1px solid #30363d",
            right: 0,
            transformOrigin: "top right"
          }}
        >
          <div className="p-3">
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs font-semibold text-[#e6edf3]">Filters</span>
              {activeCount > 0 && (
                <button
                  onClick={clearAll}
                  className="text-[10px] text-[#f85149] hover:text-[#ff7b72] transition-colors"
                >
                  Clear All
                </button>
              )}
            </div>
            
            {/* Type Section */}
            <div className="mt-3">
              <div className="text-[10px] uppercase font-semibold tracking-wider text-[#8b949e] mb-1.5 px-1">
                Type
              </div>
              <div className="flex flex-col gap-1">
                {KINDS.map((k) => {
                  const isActive = activeKinds.has(k.id);
                  return (
                    <label
                      key={k.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer hover:bg-[#21262d] transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={isActive}
                        onChange={() => toggleKind(k.id)}
                        className="hidden"
                      />
                      <div
                        className="w-4 h-4 rounded border flex items-center justify-center shrink-0"
                        style={{
                          background: isActive ? "#1f6feb" : "transparent",
                          borderColor: isActive ? "#1f6feb" : "#484f58"
                        }}
                      >
                        {isActive && (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        )}
                      </div>
                      <span className="text-xs text-[#c9d1d9]">{k.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="w-full h-px my-3 bg-[#30363d]" />

            {/* Language Section */}
            <div>
              <div className="text-[10px] uppercase font-semibold tracking-wider text-[#8b949e] mb-1.5 px-1">
                Language
              </div>
              <div className="flex flex-col gap-1">
                {LANGUAGES.map((l) => {
                  const isActive = activeLanguages.has(l.id);
                  return (
                    <label
                      key={l.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer hover:bg-[#21262d] transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={isActive}
                        onChange={() => toggleLanguage(l.id)}
                        className="hidden"
                      />
                      <div
                        className="w-4 h-4 rounded border flex items-center justify-center shrink-0"
                        style={{
                          background: isActive ? "#1f6feb" : "transparent",
                          borderColor: isActive ? "#1f6feb" : "#484f58"
                        }}
                      >
                        {isActive && (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        )}
                      </div>
                      <span className="text-xs text-[#c9d1d9]">{l.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
