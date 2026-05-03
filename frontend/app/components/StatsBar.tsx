"use client";

import type { GraphStats } from "../lib/client";

interface StatsBarProps {
  stats: GraphStats;
  owner: string;
  repo: string;
}

export default function StatsBar({ stats, owner, repo }: StatsBarProps) {
  return (
    <div className="w-full max-w-6xl mx-auto mb-6">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-2 h-2 rounded-full bg-green-400" />
        <h2 className="text-lg font-semibold text-foreground">
          {owner}/{repo}
        </h2>
        <span className="text-sm text-muted">— Analysis complete</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-9 gap-3">
        <StatCard label="Files" value={stats.totalFiles} icon="📄" />
        <StatCard label="Parsed" value={stats.parsedFiles} icon="✓" highlight />
        <StatCard label="Functions" value={stats.totalFunctions} icon="ƒ" />
        <StatCard label="Import Edges" value={stats.totalImportEdges} icon="→" />
        <StatCard label="Call Edges" value={stats.totalCallEdges} icon="⇆" />
        <StatCard label="Test Files" value={stats.testFiles} icon="🧪" />
        <StatCard label="Entry Points" value={stats.entryPoints} icon="⚡" />
        {stats.deadCodeFiles > 0 && (
          <StatCard label="Dead Code" value={stats.deadCodeFiles} icon="💀" />
        )}
        {stats.workspacePackages > 0 && (
          <StatCard label="Packages" value={stats.workspacePackages} icon="📦" />
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  highlight,
}: {
  label: string;
  value: number;
  icon: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-3 text-center transition-colors
        ${
          highlight
            ? "bg-primary/5 border-primary/20"
            : "bg-surface border-border hover:border-border/80"
        }
      `}
    >
      <div className="text-lg mb-0.5">{icon}</div>
      <div className="text-xl font-bold font-mono text-foreground">{value}</div>
      <div className="text-[11px] text-muted uppercase tracking-wider mt-0.5">{label}</div>
    </div>
  );
}
