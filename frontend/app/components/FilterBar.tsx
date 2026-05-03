"use client";

interface FilterBarProps {
  activeKinds: Set<string>;
  activeLanguages: Set<string>;
  onKindsChange: (kinds: Set<string>) => void;
  onLanguagesChange: (langs: Set<string>) => void;
}

const KINDS = [
  { id: "source", label: "Source" },
  { id: "test", label: "Tests" },
  { id: "config", label: "Config" },
  { id: "entry", label: "Entry Points" }, // Maps to isEntryPoint
  { id: "ui", label: "UI" }, // Simplistic proxy: tsx/jsx
];

const LANGUAGES = [
  { id: "typescript", label: "TS" },
  { id: "javascript", label: "JS" },
  { id: "tsx", label: "TSX" },
  { id: "jsx", label: "JSX" },
];

export default function FilterBar({
  activeKinds,
  activeLanguages,
  onKindsChange,
  onLanguagesChange,
}: FilterBarProps) {
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

  return (
    <div
      className="flex items-center gap-6 px-4 py-2"
      style={{
        background: "rgba(13,17,23,0.95)",
        borderBottom: "1px solid #30363d",
        borderTop: "1px solid #30363d",
      }}
    >
      {/* File Types */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase font-semibold tracking-wider" style={{ color: "#8b949e" }}>
          Type
        </span>
        <div className="flex gap-1">
          {KINDS.map((k) => (
            <button
              key={k.id}
              onClick={() => toggleKind(k.id)}
              className="px-2 py-1 rounded text-xs transition-colors"
              style={{
                background: activeKinds.has(k.id) ? "rgba(88,166,255,0.15)" : "transparent",
                color: activeKinds.has(k.id) ? "#58a6ff" : "#8b949e",
                border: `1px solid ${activeKinds.has(k.id) ? "rgba(88,166,255,0.4)" : "transparent"}`,
              }}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      <div className="w-px h-4" style={{ background: "#30363d" }} />

      {/* Languages */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase font-semibold tracking-wider" style={{ color: "#8b949e" }}>
          Language
        </span>
        <div className="flex gap-1">
          {LANGUAGES.map((l) => (
            <button
              key={l.id}
              onClick={() => toggleLanguage(l.id)}
              className="px-2 py-1 rounded text-xs transition-colors"
              style={{
                background: activeLanguages.has(l.id) ? "rgba(88,166,255,0.15)" : "transparent",
                color: activeLanguages.has(l.id) ? "#58a6ff" : "#8b949e",
                border: `1px solid ${activeLanguages.has(l.id) ? "rgba(88,166,255,0.4)" : "transparent"}`,
              }}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
