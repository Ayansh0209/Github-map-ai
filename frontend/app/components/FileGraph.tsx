"use client";

import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { graphStratify, sugiyama } from "d3-dag";
import type { FileNodeDTO, ImportEdgeDTO } from "../lib/types";
import { getLanguageColor, getFolderGroup } from "../lib/graphHelpers";

interface FileGraphProps {
  files: FileNodeDTO[];
  edges: ImportEdgeDTO[];
  onFileClick: (file: FileNodeDTO) => void;
  owner: string;
  repo: string;
  searchQuery: string;
  selectedFileId: string | null;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  data: FileNodeDTO;
  folder: string;
  degree: number;
  isHub: boolean;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  data: ImportEdgeDTO;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getRadius(n: SimNode): number {
  const sqrt = Math.sqrt(n.data.lineCount || 1);
  if (n.data.isEntryPoint) return Math.max(18, sqrt * 2.5);
  if (n.isHub) return Math.max(12, sqrt * 2);
  return Math.min(20, Math.max(6, sqrt * 1.5));
}

function brightenColor(hex: string): string {
  const c = d3.color(hex);
  return c ? c.brighter(1.5).formatHex() : hex;
}

function getDominantLanguageColor(nodes: SimNode[]): string {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.data.language, (counts.get(n.data.language) || 0) + 1);
  let maxLang = "unknown", maxCount = 0;
  for (const [lang, count] of counts) if (count > maxCount) { maxLang = lang; maxCount = count; }
  return getLanguageColor(maxLang);
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function FileGraph({
  files,
  edges,
  onFileClick,
  searchQuery,
  selectedFileId,
}: FileGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<d3.Selection<SVGSVGElement, unknown, null, undefined> | null>(null);
  const nodeGRef = useRef<d3.Selection<SVGGElement, SimNode, SVGGElement, unknown> | null>(null);
  const linkRef = useRef<d3.Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null>(null);
  const labelRef = useRef<d3.Selection<SVGTextElement, SimNode, SVGGElement, unknown> | null>(null);
  const simulationRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  const onFileClickRef = useRef(onFileClick);
  const selectedFileIdRef = useRef(selectedFileId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { onFileClickRef.current = onFileClick; }, [onFileClick]);
  useEffect(() => { selectedFileIdRef.current = selectedFileId; }, [selectedFileId]);

  // ── Main graph build effect ─────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || files.length === 0) return;

    // Cleanup previous
    if (simulationRef.current) simulationRef.current.stop();
    d3.select(containerRef.current).selectAll("*").remove();
    setError(null);

    const container = containerRef.current;
    const width = container.clientWidth || 900;
    const height = container.clientHeight || 600;

    try {
      // ── 1. Compute degrees ─────────────────────────────────────────────
      const degreeMap = new Map<string, number>();
      for (const e of edges) {
        degreeMap.set(e.source, (degreeMap.get(e.source) || 0) + 1);
        degreeMap.set(e.target, (degreeMap.get(e.target) || 0) + 1);
      }
      const degrees = [...degreeMap.values()].sort((a, b) => a - b);
      const hubThreshold = degrees[Math.floor(degrees.length * 0.9)] ?? Infinity;

      // ── 2. Build SimNodes ─────────────────────────────────────────────
      const nodeMap = new Map<string, SimNode>();
      const nodes: SimNode[] = files.map((f) => {
        const deg = degreeMap.get(f.id) || 0;
        const n: SimNode = {
          id: f.id,
          data: f,
          folder: getFolderGroup(f.id),
          degree: deg,
          isHub: deg >= hubThreshold && deg > 0,
        };
        nodeMap.set(f.id, n);
        return n;
      });

      const links: SimLink[] = edges
        .filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
        .map((e) => ({ source: e.source, target: e.target, data: e }));

      // ── 3. DAG layout (try, gracefully fallback) ──────────────────────
      const adj = new Map<string, string[]>();
      for (const e of edges) {
        if (!adj.has(e.source)) adj.set(e.source, []);
        adj.get(e.source)!.push(e.target);
      }

      // DFS to break cycles
      const visited = new Set<string>();
      const onStack = new Set<string>();
      const dagParents = new Map<string, string[]>();

      const dfs = (u: string) => {
        visited.add(u); onStack.add(u);
        for (const v of adj.get(u) || []) {
          if (!onStack.has(v)) { // don't follow back-edges
            if (!dagParents.has(v)) dagParents.set(v, []);
            dagParents.get(v)!.push(u);
            if (!visited.has(v)) dfs(v);
          }
        }
        onStack.delete(u);
      };
      files.filter(f => f.isEntryPoint).forEach(f => { if (!visited.has(f.id)) dfs(f.id); });
      files.forEach(f => { if (!visited.has(f.id)) dfs(f.id); });

      const dagData = files.map(f => ({ id: f.id, parentIds: dagParents.get(f.id) || [] }));

      try {
        const graph = graphStratify()(dagData);
        sugiyama().nodeSize([120, 100])(graph);
        for (const dagNode of graph.nodes()) {
          const n = nodeMap.get(dagNode.data.id);
          if (n && dagNode.x !== undefined) { n.x = dagNode.x; n.y = dagNode.y; }
        }
      } catch {
        // fallback: random start positions — force simulation handles layout
        nodes.forEach((n, i) => {
          n.x = (Math.random() - 0.5) * width;
          n.y = (Math.random() - 0.5) * height;
        });
      }

      // ── 4. SVG ─────────────────────────────────────────────────────────
      const svg = d3
        .select(container)
        .append("svg")
        .attr("width", "100%")
        .attr("height", "100%")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("preserveAspectRatio", "xMidYMid meet");
      svgRef.current = svg;

      const defs = svg.append("defs");
      for (const [id, color] of [["default", "#30363d"], ["highlight", "#58a6ff"]]) {
        defs.append("marker")
          .attr("id", `arrow-${id}`)
          .attr("viewBox", "0 -5 10 10")
          .attr("refX", 20).attr("refY", 0)
          .attr("markerWidth", 5).attr("markerHeight", 5)
          .attr("orient", "auto")
          .append("path").attr("d", "M0,-4L10,0L0,4").attr("fill", color);
      }

      const g = svg.append("g");
      const zoom = d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.05, 8])
        .on("zoom", (ev) => g.attr("transform", ev.transform));
      svg.call(zoom);

      const folderBg = g.append("g").attr("class", "folder-bg");

      // Tooltip div
      const tooltip = d3.select(container).append("div")
        .style("position", "absolute")
        .style("background", "rgba(13,17,23,0.95)")
        .style("border", "1px solid #30363d")
        .style("border-radius", "8px")
        .style("padding", "8px 12px")
        .style("font-size", "12px")
        .style("color", "#e6edf3")
        .style("pointer-events", "none")
        .style("opacity", "0")
        .style("max-width", "260px")
        .style("z-index", "100");

      // ── 5. Edges ───────────────────────────────────────────────────────
      const link = g.append("g")
        .selectAll<SVGLineElement, SimLink>("line")
        .data(links)
        .join("line")
        .attr("stroke", d => d.data.isTypeOnly ? "#2d333b" : "#30363d")
        .attr("stroke-width", d => d.data.isTypeOnly ? 0.5 : Math.min(3, Math.max(1, (d.data.symbols?.length || 1) * 0.4)))
        .attr("stroke-dasharray", d => d.data.kind === "dynamic" ? "5,3" : "none")
        .attr("marker-end", "url(#arrow-default)");
      linkRef.current = link;

      // ── 6. Nodes ───────────────────────────────────────────────────────
      const nodeG = g.append("g")
        .selectAll<SVGGElement, SimNode>("g")
        .data(nodes)
        .join("g")
        .style("cursor", "pointer")
        .call(
          d3.drag<SVGGElement, SimNode>()
            .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
            .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
            .on("end", (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
        );
      nodeGRef.current = nodeG;

      // Draw shapes
      nodeG.each(function (d) {
        const g2 = d3.select(this);
        const r = getRadius(d);

        if (d.data.kind === "config") {
          g2.append("path")
            .attr("d", `M0,${-r} L${r},0 L0,${r} L${-r},0 Z`)
            .attr("fill", "#6b7280");
        } else {
          const circle = g2.append("circle").attr("r", r);
          if (d.data.isEntryPoint) {
            circle.attr("fill", "#22c55e");
            // pulse ring
            g2.append("circle").attr("r", r + 4)
              .attr("fill", "none")
              .attr("stroke", "#22c55e")
              .attr("stroke-width", 1.5)
              .attr("stroke-opacity", 0.5)
              .attr("class", "pulse-ring");
          } else if (d.isHub) {
            circle.attr("fill", brightenColor(getLanguageColor(d.data.language)));
          } else {
            circle.attr("fill", getLanguageColor(d.data.language));
          }
          if (d.data.kind === "test") {
            circle.attr("fill-opacity", 0.5)
              .attr("stroke", "#22c55e")
              .attr("stroke-width", 1.5)
              .attr("stroke-dasharray", "3,2");
          }
        }

        // Label
        const always = d.data.isEntryPoint || d.isHub || d.degree >= 5;
        g2.append("text")
          .attr("dy", getRadius(d) + 13)
          .attr("text-anchor", "middle")
          .attr("fill", "#e6edf3")
          .attr("font-size", "10px")
          .attr("font-family", "ui-monospace, monospace")
          .attr("pointer-events", "none")
          .attr("opacity", always ? 1 : 0)
          .text(d.data.label);
      });

      labelRef.current = nodeG.select<SVGTextElement>("text");

      // ── 7. Interactions ────────────────────────────────────────────────
      nodeG
        .on("mouseover", function (ev, d) {
          d3.select(this).select("text").attr("opacity", 1);
          const connectedIds = new Set([d.id]);
          links.forEach(l => {
            const s = (l.source as SimNode).id, t = (l.target as SimNode).id;
            if (s === d.id) connectedIds.add(t);
            if (t === d.id) connectedIds.add(s);
          });
          nodeG.attr("opacity", n => connectedIds.has(n.id) ? 1 : 0.08);
          link
            .attr("stroke", l => {
              const s = (l.source as SimNode).id, t = (l.target as SimNode).id;
              return s === d.id || t === d.id ? "#58a6ff" : "#1c2128";
            })
            .attr("stroke-opacity", l => {
              const s = (l.source as SimNode).id, t = (l.target as SimNode).id;
              return s === d.id || t === d.id ? 1 : 0.05;
            })
            .attr("marker-end", l => {
              const s = (l.source as SimNode).id, t = (l.target as SimNode).id;
              return s === d.id || t === d.id ? "url(#arrow-highlight)" : "url(#arrow-default)";
            });
          tooltip.style("opacity", "1")
            .html(`<strong>${d.data.label}</strong><br/><span style="color:#8b949e">${d.data.path}</span><br/>${d.data.language} · ${d.data.lineCount} lines · ${d.data.kind}${d.data.isEntryPoint ? " · <span style='color:#22c55e'>entry</span>" : ""}`)
            .style("left", (ev.offsetX + 16) + "px")
            .style("top", (ev.offsetY - 10) + "px");
        })
        .on("mouseout", function (_ev, d) {
          const always = d.data.isEntryPoint || d.isHub || d.degree >= 5 || d.id === selectedFileIdRef.current;
          d3.select(this).select("text").attr("opacity", always ? 1 : 0);
          nodeG.attr("opacity", 1);
          link.attr("stroke", l => l.data.isTypeOnly ? "#2d333b" : "#30363d")
            .attr("stroke-opacity", 1)
            .attr("marker-end", "url(#arrow-default)");
          tooltip.style("opacity", "0");
        })
        .on("click", (_ev, d) => { onFileClickRef.current(d.data); });

      // ── 8. Force simulation ────────────────────────────────────────────
      const sim = d3.forceSimulation<SimNode>(nodes)
        .force("link", d3.forceLink<SimNode, SimLink>(links).id(d => d.id).distance(70).strength(0.5))
        .force("charge", d3.forceManyBody().strength(-200))
        .force("collision", d3.forceCollide<SimNode>().radius(d => getRadius(d) + 6))
        .force("x", d3.forceX<SimNode>(d => (d.x ?? 0)).strength(0.08))
        .force("y", d3.forceY<SimNode>(d => (d.y ?? 0)).strength(0.08))
        .force("center", d3.forceCenter(width / 2, height / 2).strength(0.02));
      simulationRef.current = sim;

      sim.on("tick", () => {
        link
          .attr("x1", d => (d.source as SimNode).x!)
          .attr("y1", d => (d.source as SimNode).y!)
          .attr("x2", d => (d.target as SimNode).x!)
          .attr("y2", d => (d.target as SimNode).y!);
        nodeG.attr("transform", d => `translate(${d.x ?? 0},${d.y ?? 0})`);
      });

      sim.on("end", () => {
        // Folder backgrounds
        const byFolder = new Map<string, SimNode[]>();
        for (const n of nodes) {
          if (!byFolder.has(n.folder)) byFolder.set(n.folder, []);
          byFolder.get(n.folder)!.push(n);
        }
        for (const [folder, fNodes] of byFolder) {
          if (fNodes.length < 3) continue;
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const n of fNodes) {
            const r = getRadius(n);
            x0 = Math.min(x0, (n.x ?? 0) - r); y0 = Math.min(y0, (n.y ?? 0) - r);
            x1 = Math.max(x1, (n.x ?? 0) + r); y1 = Math.max(y1, (n.y ?? 0) + r);
          }
          if (!isFinite(x0)) continue;
          const pad = 24, color = getDominantLanguageColor(fNodes);
          folderBg.append("rect")
            .attr("x", x0 - pad).attr("y", y0 - pad)
            .attr("width", x1 - x0 + pad * 2).attr("height", y1 - y0 + pad * 2)
            .attr("rx", 10).attr("fill", color).attr("fill-opacity", 0.06)
            .attr("pointer-events", "none");
          folderBg.append("text")
            .attr("x", x0 - pad + 8).attr("y", y0 - pad + 16)
            .text(folder === "/" ? "(root)" : folder)
            .attr("fill", color).attr("font-size", "11px").attr("font-weight", "600")
            .attr("font-family", "system-ui, sans-serif").attr("opacity", 0.7)
            .attr("pointer-events", "none");
        }

        // Auto-fit
        const b = (g.node() as SVGGElement)?.getBBox();
        if (b && b.width > 0) {
          const scale = 0.85 / Math.max(b.width / width, b.height / height);
          const tx = width / 2 - (b.x + b.width / 2) * scale;
          const ty = height / 2 - (b.y + b.height / 2) * scale;
          svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
        }
      });

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("FileGraph build error:", err);
      setError(msg);
    }

    return () => {
      simulationRef.current?.stop();
    };
  }, [files, edges]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Search filter effect ────────────────────────────────────────────────────
  useEffect(() => {
    if (!nodeGRef.current || !linkRef.current) return;
    const q = searchQuery.toLowerCase().trim();
    if (!q) {
      nodeGRef.current.attr("opacity", 1);
      linkRef.current.attr("stroke-opacity", 1);
      nodeGRef.current.select<SVGTextElement>("text").attr("opacity", (d: SimNode) =>
        d.data.isEntryPoint || d.isHub || d.degree >= 5 || d.id === selectedFileIdRef.current ? 1 : 0
      );
      return;
    }
    nodeGRef.current.attr("opacity", (d: SimNode) =>
      d.data.path.toLowerCase().includes(q) || d.data.label.toLowerCase().includes(q) ? 1 : 0.05
    );
    nodeGRef.current.select<SVGTextElement>("text").attr("opacity", (d: SimNode) =>
      d.data.path.toLowerCase().includes(q) ? 1 : 0
    );
    linkRef.current.attr("stroke-opacity", 0.03);
  }, [searchQuery]);

  return (
    <div className="w-full relative" style={{ height: "75vh" }}>
      {/* Legend */}
      <div className="absolute bottom-4 left-4 z-10 border rounded-xl p-3 text-xs space-y-1.5"
        style={{ background: "rgba(13,17,23,0.92)", borderColor: "#30363d", pointerEvents: "none" }}>
        <div className="font-semibold mb-2" style={{ color: "#8b949e" }}>Legend</div>
        {[
          { color: "#3178c6", label: "TypeScript" },
          { color: "#f7df1e", label: "JavaScript", dark: true },
          { color: "#7c3aed", label: "TSX" },
          { color: "#ea580c", label: "JSX" },
        ].map(({ color, label }) => (
          <div key={label} className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: color }} />
            <span style={{ color: "#e6edf3" }}>{label}</span>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: "#22c55e" }} />
          <span style={{ color: "#e6edf3" }}>Entry Point</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full flex-shrink-0 border border-dashed" style={{ borderColor: "#22c55e" }} />
          <span style={{ color: "#e6edf3" }}>Test file</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="12" height="12" viewBox="0 0 20 20"><path d="M10 0L20 10L10 20L0 10Z" fill="#6b7280" /></svg>
          <span style={{ color: "#e6edf3" }}>Config file</span>
        </div>
      </div>
      {error && (
        <div className="absolute inset-0 flex items-center justify-center z-20">
          <div className="bg-red-950 border border-red-500 rounded-xl p-6 max-w-md text-center">
            <p className="text-red-300 font-bold mb-2">Graph Error</p>
            <p className="text-red-200 text-xs font-mono">{error}</p>
          </div>
        </div>
      )}
      <div ref={containerRef} className="w-full h-full rounded-2xl overflow-hidden"
        style={{ background: "#0d1117", border: "1px solid #30363d" }} />
    </div>
  );
}
