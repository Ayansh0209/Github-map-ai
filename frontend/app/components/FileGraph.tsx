"use client";

import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { graphStratify, sugiyama } from "d3-dag";
import type { FileNodeDTO, ImportEdgeDTO } from "../lib/types";
import { getLanguageColor, getFolderGroup } from "../lib/graphHelpers";

interface FileGraphProps {
  files: FileNodeDTO[];
  edges: ImportEdgeDTO[];
  onFileClick: (file: FileNodeDTO | null) => void;
  owner: string;
  repo: string;
  searchQuery: string;
  selectedFileId: string | null;
  resetZoomRef?: React.MutableRefObject<(() => void) | null>;
  highlightedIssueFiles?: Map<string, number>; // fileId -> confidence (0-100)
  focusMode?: boolean;
  zoomToNodeRef?: React.MutableRefObject<((fileId: string) => void) | null>;
  filteredNodeIds?: Set<string>;
}

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

function trunc(s: string, max: number) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export default function FileGraph({
  files, edges, onFileClick, searchQuery, selectedFileId, resetZoomRef, highlightedIssueFiles = new Map(),
  focusMode = false, zoomToNodeRef, filteredNodeIds,
}: FileGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<d3.Selection<SVGSVGElement, unknown, null, undefined> | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const gRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const nodeGRef = useRef<d3.Selection<SVGGElement, SimNode, SVGGElement, unknown> | null>(null);
  const linkRef = useRef<d3.Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null>(null);
  const simulationRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  const autoFittedRef = useRef(false);
  const onFileClickRef = useRef(onFileClick);
  const selectedFileIdRef = useRef(selectedFileId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { onFileClickRef.current = onFileClick; }, [onFileClick]);
  useEffect(() => { selectedFileIdRef.current = selectedFileId; }, [selectedFileId]);

  // ── Issue-highlight ring — orange rings sized by confidence ───────────────────
  useEffect(() => {
    if (!nodeGRef.current) return;

    // Clear all rings first
    nodeGRef.current.selectAll<SVGCircleElement, SimNode>(".issue-ring")
      .attr("r", 0).attr("stroke-opacity", 0).attr("fill-opacity", 0);

    // Reset node colors back to normal
    nodeGRef.current.selectAll<SVGCircleElement, SimNode>(".node-circle")
      .attr("fill", d => {
        if (d.data.isEntryPoint) return "#22c55e";
        if (d.data.isDeadCode) return "#30363d";
        return d.isHub ? brightenColor(getLanguageColor(d.data.language)) : getLanguageColor(d.data.language);
      });

    if (highlightedIssueFiles.size > 0) {
      nodeGRef.current
        .filter((d: SimNode) => highlightedIssueFiles.has(d.id))
        .select<SVGCircleElement>(".issue-ring")
        .each(function(d: SimNode) {
          const confidence = highlightedIssueFiles.get(d.id) ?? 50;
          const strokeWidth = confidence >= 80 ? 3 : confidence >= 50 ? 2 : 1;
          const opacity = confidence >= 80 ? 1.0 : confidence >= 50 ? 0.8 : 0.6;
          d3.select(this)
            .attr("r", getRadius(d) + 10)
            .attr("stroke-width", strokeWidth)
            .attr("stroke-opacity", opacity)
            .attr("fill-opacity", 0.1);
        });
    }
  }, [highlightedIssueFiles]);

  // ── Focus mode & Filter bar (Correction 3) ──────────────────────────────────
  useEffect(() => {
    if (!nodeGRef.current || !linkRef.current) return;
    
    nodeGRef.current.attr("opacity", (d: SimNode) => {
      let focusOpacity = 1.0;
      if (focusMode && highlightedIssueFiles.size > 0 && !highlightedIssueFiles.has(d.id)) {
        focusOpacity = 0.15;
      }
      let filterOpacity = 1.0;
      if (filteredNodeIds && !filteredNodeIds.has(d.id)) {
        filterOpacity = 0.05;
      }
      return Math.min(focusOpacity, filterOpacity);
    });

    linkRef.current.attr("stroke-opacity", (d: SimLink) => {
      const s = (d.source as SimNode).id;
      const t = (d.target as SimNode).id;
      
      let sFiltered = filteredNodeIds && !filteredNodeIds.has(s);
      let tFiltered = filteredNodeIds && !filteredNodeIds.has(t);
      if (sFiltered || tFiltered) return 0; // hide edges entirely if endpoint is filtered

      if (focusMode && highlightedIssueFiles.size > 0) {
        return 0.05;
      }
      return d.data.isCircular ? 1 : 0.7;
    });

    // Make filtered nodes non-interactive
    nodeGRef.current.style("pointer-events", (d: SimNode) => 
      (filteredNodeIds && !filteredNodeIds.has(d.id)) ? "none" : "auto"
    );
  }, [focusMode, highlightedIssueFiles, filteredNodeIds]);

  // ── Zoom to node (exposed via ref) ────────────────────────────────────────────
  useEffect(() => {
    if (!zoomToNodeRef) return;
    zoomToNodeRef.current = (fileId: string) => {
      if (!simulationRef.current || !svgRef.current || !zoomRef.current) return;
      const node = simulationRef.current.nodes().find(n => n.id === fileId);
      if (!node || node.x == null || node.y == null) return;
      const container = containerRef.current;
      const w = container?.clientWidth || 900;
      const h = container?.clientHeight || 600;
      const scale = 2.5;
      svgRef.current.transition().duration(600)
        .call(zoomRef.current.transform,
          d3.zoomIdentity.translate(w / 2 - node.x * scale, h / 2 - node.y * scale).scale(scale)
        );
    };
  }, [zoomToNodeRef]);

  // ── Selection ring — runs when selectedFileId changes, NO camera move ────────
  useEffect(() => {
    if (!nodeGRef.current) return;
    // Must use selectAll to clear ALL sel-rings, not just the first
    nodeGRef.current.selectAll<SVGCircleElement, SimNode>(".sel-ring")
      .attr("r", 0).attr("stroke-opacity", 0);
    if (selectedFileId) {
      nodeGRef.current
        .filter((d: SimNode) => d.id === selectedFileId)
        .select<SVGCircleElement>(".sel-ring")
        .attr("r", (d: SimNode) => getRadius(d) + 7)
        .attr("stroke-opacity", 1);
    }
    nodeGRef.current.selectAll<SVGTextElement, SimNode>("g.node-label").attr("opacity", (d: SimNode) =>
      d.data.isEntryPoint || d.degree >= 5 || d.id === selectedFileId ? 1 : 0
    );
  }, [selectedFileId]);

  // ── Main graph build ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || files.length === 0) return;
    autoFittedRef.current = false;
    simulationRef.current?.stop();
    d3.select(containerRef.current).selectAll("*").remove();
    setError(null);

    const container = containerRef.current;
    const width = container.clientWidth || 900;
    const height = container.clientHeight || 600;

    try {
      // 1. Degrees
      const degreeMap = new Map<string, number>();
      for (const e of edges) {
        degreeMap.set(e.source, (degreeMap.get(e.source) || 0) + 1);
        degreeMap.set(e.target, (degreeMap.get(e.target) || 0) + 1);
      }
      const sorted = [...degreeMap.values()].sort((a, b) => a - b);
      const hubThreshold = sorted[Math.floor(sorted.length * 0.9)] ?? Infinity;
      const top15Threshold = sorted[Math.floor(sorted.length * 0.85)] ?? Infinity;

      // 2. Build nodes
      const nodeMap = new Map<string, SimNode>();
      const nodes: SimNode[] = files.map(f => {
        const deg = degreeMap.get(f.id) || 0;
        const n: SimNode = { id: f.id, data: f, folder: getFolderGroup(f.id), degree: deg, isHub: deg >= top15Threshold && deg > 0 };
        nodeMap.set(f.id, n);
        return n;
      });
      const links: SimLink[] = edges
        .filter(e => nodeMap.has(e.source) && nodeMap.has(e.target))
        .map(e => ({ source: e.source, target: e.target, data: e }));

      // 3. DAG layout with cycle-breaking DFS
      const adj = new Map<string, string[]>();
      for (const e of edges) { if (!adj.has(e.source)) adj.set(e.source, []); adj.get(e.source)!.push(e.target); }
      const visited = new Set<string>(), onStack = new Set<string>(), dagParents = new Map<string, string[]>();
      const dfs = (u: string) => {
        visited.add(u); onStack.add(u);
        for (const v of adj.get(u) || []) {
          if (!onStack.has(v)) {
            if (!dagParents.has(v)) dagParents.set(v, []);
            dagParents.get(v)!.push(u);
            if (!visited.has(v)) dfs(v);
          }
        }
        onStack.delete(u);
      };
      files.filter(f => f.isEntryPoint).forEach(f => { if (!visited.has(f.id)) dfs(f.id); });
      files.forEach(f => { if (!visited.has(f.id)) dfs(f.id); });
      try {
        const graph = graphStratify()(files.map(f => ({ id: f.id, parentIds: dagParents.get(f.id) || [] })));
        sugiyama().nodeSize([120, 100])(graph);
        for (const dn of graph.nodes()) { const n = nodeMap.get(dn.data.id); if (n && dn.x !== undefined) { n.x = dn.x; n.y = dn.y; } }
      } catch {
        nodes.forEach(n => { n.x = (Math.random() - 0.5) * width; n.y = (Math.random() - 0.5) * height; });
      }

      // 4. SVG
      const svg = d3.select(container).append("svg")
        .attr("width", "100%").attr("height", "100%")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("preserveAspectRatio", "xMidYMid meet")
        .on("click", (ev) => {
          if (ev.target.tagName === "svg" || ev.target.tagName === "rect") {
            onFileClickRef.current(null);
          }
        });
      svgRef.current = svg;

      const defs = svg.append("defs");
      for (const [id, col] of [["default", "#252c36"], ["highlight", "#58a6ff"]] as [string, string][]) {
        defs.append("marker").attr("id", `arrow-${id}`).attr("viewBox", "0 -5 10 10")
          .attr("refX", 22).attr("refY", 0).attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto")
          .append("path").attr("d", "M0,-4L10,0L0,4").attr("fill", col);
      }
      // Hub glow filter
      const filt = defs.append("filter").attr("id", "hub-glow").attr("x", "-50%").attr("y", "-50%").attr("width", "200%").attr("height", "200%");
      filt.append("feGaussianBlur").attr("stdDeviation", "3").attr("result", "blur");
      const fm = filt.append("feMerge");
      fm.append("feMergeNode").attr("in", "blur");
      fm.append("feMergeNode").attr("in", "SourceGraphic");

      const g = svg.append("g");
      gRef.current = g;
      const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.05, 8])
        .on("zoom", ev => g.attr("transform", ev.transform));
      zoomRef.current = zoom;
      svg.call(zoom);

      // Expose reset zoom via ref
      if (resetZoomRef) {
        resetZoomRef.current = () => {
          const b = (g.node() as SVGGElement)?.getBBox();
          if (!b || b.width === 0) return;
          const scale = 0.85 / Math.max(b.width / width, b.height / height);
          svg.transition().duration(600).call(zoom.transform,
            d3.zoomIdentity.translate(width / 2 - (b.x + b.width / 2) * scale, height / 2 - (b.y + b.height / 2) * scale).scale(scale));
        };
      }

      const folderBg = g.append("g").attr("class", "folder-bg");
      const tooltip = d3.select(container).append("div")
        .style("position", "absolute").style("background", "rgba(13,17,23,0.95)")
        .style("border", "1px solid #30363d").style("border-radius", "8px")
        .style("padding", "8px 12px").style("font-size", "12px").style("color", "#e6edf3")
        .style("pointer-events", "none").style("opacity", "0").style("max-width", "260px").style("z-index", "100");

      // 5. Edges
      const link = g.append("g")
        .selectAll<SVGLineElement, SimLink>("line").data(links).join("line")
        .attr("stroke", d => d.data.isCircular ? "#f85149" : d.data.isTypeOnly ? "#1c2128" : "#252c36")
        .attr("stroke-width", d => d.data.isTypeOnly ? 0.5 : Math.max(1, (d.data.weight || 1) * 0.8))
        .attr("stroke-dasharray", d => d.data.isCircular ? "6,4" : d.data.kind === "dynamic" ? "5,3" : "none")
        .attr("stroke-opacity", d => d.data.isCircular ? 1 : 0.7).attr("marker-end", "url(#arrow-default)");
      linkRef.current = link;

      // 6. Nodes
      const nodeG = g.append("g")
        .selectAll<SVGGElement, SimNode>("g").data(nodes).join("g")
        .style("cursor", "pointer")
        .call(d3.drag<SVGGElement, SimNode>()
          .on("start", (_ev, d) => { d.fx = d.x; d.fy = d.y; })
          .on("drag", (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = ev.x; d.fy = ev.y; })
          .on("end", (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));
      nodeGRef.current = nodeG;

      nodeG.each(function (d) {
        const g2 = d3.select(this);
        const r = getRadius(d);
        // Issue highlight ring (orange — confidence-based thickness)
        g2.append("circle").attr("class", "issue-ring").attr("r", 0)
          .attr("fill", "rgba(249,115,22,0.1)").attr("stroke", "#f97316").attr("stroke-width", 2)
          .attr("stroke-opacity", 0).attr("fill-opacity", 0).attr("pointer-events", "none");
        // Selection ring (orange, hidden by default)
        g2.append("circle").attr("class", "sel-ring").attr("r", 0)
          .attr("fill", "none").attr("stroke", "#f0883e").attr("stroke-width", 2.5)
          .attr("stroke-opacity", 0).attr("pointer-events", "none");
        // Hover ring (blue, hidden by default)
        g2.append("circle").attr("class", "hover-ring").attr("r", 0)
          .attr("fill", "none").attr("stroke", "#58a6ff").attr("stroke-width", 1.5)
          .attr("stroke-opacity", 0).attr("pointer-events", "none");

        if (d.data.kind === "config") {
          g2.append("path").attr("d", `M0,${-r} L${r},0 L0,${r} L${-r},0 Z`).attr("fill", "#6b7280");
        } else {
          const circle = g2.append("circle").attr("r", r);
          if (d.data.isEntryPoint) {
            circle.attr("fill", "#22c55e");
            g2.append("circle").attr("r", r + 5).attr("fill", "none")
              .attr("stroke", "#22c55e").attr("stroke-width", 1.5).attr("stroke-opacity", 0.35).attr("pointer-events", "none");
          } else if (d.isHub) {
            circle.attr("fill", brightenColor(getLanguageColor(d.data.language))).attr("filter", "url(#hub-glow)");
          } else {
            circle.attr("fill", getLanguageColor(d.data.language));
          }
          if (d.data.kind === "test") {
            circle.attr("fill-opacity", 0.45).attr("stroke", "#22c55e").attr("stroke-width", 1.5).attr("stroke-dasharray", "3,2");
          }
          // Subtle dead code indicator — lower opacity + faint red dashed ring
          if (d.data.isDeadCode) {
            circle.attr("fill-opacity", 0.25);
            g2.append("circle").attr("r", r + 3).attr("fill", "none")
              .attr("stroke", "#f85149").attr("stroke-width", 1).attr("stroke-opacity", 0.3)
              .attr("stroke-dasharray", "2,3").attr("pointer-events", "none");
          }
        }

        // Label
        const important = d.data.isEntryPoint || d.degree >= 5 || d.isHub;
        const textLabel = trunc(d.data.label, 18);
        const labelGroup = g2.append("g")
          .attr("class", "node-label")
          .attr("transform", `translate(0, ${r + 12})`)
          .attr("pointer-events", "none")
          .attr("opacity", important ? 1 : 0);
          
        labelGroup.append("rect")
          .attr("x", -((textLabel.length * 6) / 2) - 4)
          .attr("y", -10)
          .attr("width", (textLabel.length * 6) + 8)
          .attr("height", 14)
          .attr("rx", 4)
          .attr("fill", "rgba(13,17,23,0.85)")
          .attr("pointer-events", "none");
          
        labelGroup.append("text")
          .attr("text-anchor", "middle")
          .attr("fill", "#e6edf3")
          .attr("font-size", "10px")
          .attr("font-family", "var(--font-geist-mono), monospace")
          .attr("pointer-events", "none")
          .text(textLabel);
      });

      // 7. Interactions
      nodeG
        .on("mouseover", function (ev, d) {
          if (selectedFileIdRef.current) return; // don't hover-highlight if something is locked
          d3.select(this).select(".hover-ring").attr("r", getRadius(d) + 4).attr("stroke-opacity", 0.8);
          d3.select(this).select("g.node-label").attr("opacity", 1);
          const conn = new Set([d.id]);
          links.forEach(l => { const s = (l.source as SimNode).id, t = (l.target as SimNode).id; if (s === d.id) conn.add(t); if (t === d.id) conn.add(s); });
          nodeG.attr("opacity", n => conn.has(n.id) ? 1 : 0.06);
          link.attr("stroke", l => { const s = (l.source as SimNode).id, t = (l.target as SimNode).id; return l.data.isCircular ? "#f85149" : (s === d.id || t === d.id ? "#58a6ff" : "#1c2128"); })
            .attr("stroke-opacity", l => { const s = (l.source as SimNode).id, t = (l.target as SimNode).id; return s === d.id || t === d.id ? 1 : 0.03; })
            .attr("marker-end", l => { const s = (l.source as SimNode).id, t = (l.target as SimNode).id; return s === d.id || t === d.id ? "url(#arrow-highlight)" : "url(#arrow-default)"; });
          tooltip.style("opacity", "1")
            .html(`<strong>${d.data.label}</strong><br/><span style="color:#8b949e">${d.data.path}</span><br/>${d.data.language} · ${d.data.lineCount} lines${d.data.isEntryPoint ? ' · <span style="color:#22c55e">entry</span>' : ""}`)
            .style("left", (ev.offsetX + 16) + "px").style("top", (ev.offsetY - 10) + "px");
        })
        .on("mouseout", function (_ev, d) {
          if (selectedFileIdRef.current) return;
          d3.select(this).select(".hover-ring").attr("r", 0).attr("stroke-opacity", 0);
          const label = d3.select(this).select("g.node-label");
          const always = d.data.isEntryPoint || d.degree >= 5 || d.isHub || d.id === selectedFileIdRef.current;
          if (!always) {
            setTimeout(() => { label.attr("opacity", 0); }, 2500); // fade out slowly or delayed hide
          }
          
          nodeG.attr("opacity", (n: SimNode) => {
            if (filteredNodeIds && !filteredNodeIds.has(n.id)) return 0.05;
            if (focusMode && highlightedIssueFiles.size > 0 && !highlightedIssueFiles.has(n.id)) return 0.15;
            return 1;
          });
          link.attr("stroke", l => l.data.isCircular ? "#f85149" : l.data.isTypeOnly ? "#1c2128" : "#252c36").attr("stroke-opacity", (l: SimLink) => {
            const s = (l.source as SimNode).id, t = (l.target as SimNode).id;
            if (filteredNodeIds && (!filteredNodeIds.has(s) || !filteredNodeIds.has(t))) return 0;
            if (focusMode && highlightedIssueFiles.size > 0) return 0.05;
            return l.data.isCircular ? 1 : 0.7;
          }).attr("marker-end", "url(#arrow-default)");
          tooltip.style("opacity", "0");
        })
        .on("click", (_ev, d) => { onFileClickRef.current(d.data); })
        .on("dblclick", function (ev, d) {
          ev.stopPropagation();
          if (!svgRef.current || !zoomRef.current || d.x == null || d.y == null) return;
          const scale = 2.5;
          svgRef.current.transition().duration(500).call(zoomRef.current.transform,
            d3.zoomIdentity.translate(width / 2 - d.x * scale, height / 2 - d.y * scale).scale(scale));
        });

      // 8. Simulation
      const sim = d3.forceSimulation<SimNode>(nodes)
        .force("link", d3.forceLink<SimNode, SimLink>(links).id(d => d.id)
          .distance(d => {
            const s = d.source as SimNode;
            const t = d.target as SimNode;
            if (s.data.isEntryPoint || t.data.isEntryPoint) return 180;
            if (s.isHub || t.isHub) return 120;
            return 70;
          })
          .strength(0.5)
        )
        .force("charge", d3.forceManyBody<SimNode>().strength(d => {
          if (d.data.isEntryPoint) return -800;
          if (d.isHub) return -500;
          if (d.data.kind === "test") return -300;
          return -200;
        }))
        .force("collision", d3.forceCollide<SimNode>().radius(d => {
          let r = getRadius(d) + 12;
          if (d.data.isEntryPoint) r += 40;
          else if (d.isHub) r += 20;
          return r;
        }).iterations(3))
        .force("x", d3.forceX<SimNode>(width / 2).strength(0.03))
        .force("y", d3.forceY<SimNode>(height / 2).strength(0.03))
        .force("center", d3.forceCenter(width / 2, height / 2).strength(0.05));
      simulationRef.current = sim;

      sim.on("tick", () => {
        link.attr("x1", d => (d.source as SimNode).x!).attr("y1", d => (d.source as SimNode).y!)
          .attr("x2", d => (d.target as SimNode).x!).attr("y2", d => (d.target as SimNode).y!);
        nodeG.attr("transform", d => `translate(${d.x ?? 0},${d.y ?? 0})`);
      });

      sim.on("end", () => {
        // Folder cluster backgrounds — only render once, 4+ nodes, capped at 8 folders
        const byFolder = new Map<string, SimNode[]>();
        for (const n of nodes) { if (!byFolder.has(n.folder)) byFolder.set(n.folder, []); byFolder.get(n.folder)!.push(n); }
        const topFolders = [...byFolder.entries()]
          .filter(([, ns]) => ns.length >= 4)
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 8);

        folderBg.selectAll("*").remove();

        for (const [folder, fNodes] of topFolders) {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const n of fNodes) { const r = getRadius(n); x0 = Math.min(x0, (n.x ?? 0) - r); y0 = Math.min(y0, (n.y ?? 0) - r); x1 = Math.max(x1, (n.x ?? 0) + r); y1 = Math.max(y1, (n.y ?? 0) + r); }
          if (!isFinite(x0)) continue;
          const pad = 16;
          folderBg.append("rect").attr("x", x0 - pad).attr("y", y0 - pad)
            .attr("width", x1 - x0 + pad * 2).attr("height", y1 - y0 + pad * 2)
            .attr("rx", 10).attr("fill", "#ffffff").attr("fill-opacity", 0.03)
            .attr("stroke", "rgba(255,255,255,0.06)").attr("stroke-width", 1)
            .attr("pointer-events", "none");
          folderBg.append("text").attr("x", x0 - pad + 6).attr("y", y0 - pad + 14)
            .text(trunc(folder === "/" ? "(root)" : folder, 30))
            .attr("fill", "rgba(255,255,255,0.25)").attr("font-size", "9px")
            .attr("font-family", "system-ui, sans-serif").attr("pointer-events", "none");
        }

        // Auto-fit only once
        if (!autoFittedRef.current) {
          autoFittedRef.current = true;
          const b = (g.node() as SVGGElement)?.getBBox();
          if (b && b.width > 0) {
            const scale = 0.85 / Math.max(b.width / width, b.height / height);
            svg.transition().duration(600).call(zoom.transform,
              d3.zoomIdentity.translate(width / 2 - (b.x + b.width / 2) * scale, height / 2 - (b.y + b.height / 2) * scale).scale(scale));
          }
        }
      });

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("FileGraph error:", err);
      setError(msg);
    }

    return () => { simulationRef.current?.stop(); };
  }, [files, edges]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Search filter ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!nodeGRef.current || !linkRef.current) return;
    const q = searchQuery.toLowerCase().trim();
    if (!q) {
      nodeGRef.current.attr("opacity", 1);
      linkRef.current.attr("stroke-opacity", 0.7);
      nodeGRef.current.select<SVGTextElement>("text").attr("opacity", (d: SimNode) =>
        d.data.isEntryPoint || d.isHub || d.degree >= 5 || d.id === selectedFileIdRef.current ? 1 : 0);
      return;
    }
    nodeGRef.current.attr("opacity", (d: SimNode) =>
      d.data.path.toLowerCase().includes(q) || d.data.label.toLowerCase().includes(q) ? 1 : 0.04);
    nodeGRef.current.select<SVGTextElement>("g.node-label").attr("opacity", (d: SimNode) =>
      d.data.path.toLowerCase().includes(q) ? 1 : 0);
    linkRef.current.attr("stroke-opacity", 0.02);
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="w-full relative flex-1" style={{ height: "100%" }}>
      <div className="absolute bottom-4 left-4 z-10 border rounded-xl p-3 text-xs space-y-1.5"
        style={{ background: "rgba(13,17,23,0.92)", borderColor: "#30363d", pointerEvents: "none" }}>
        <div className="font-semibold mb-2" style={{ color: "#8b949e" }}>Legend</div>
        {[{ color: "#3178c6", label: "TypeScript" }, { color: "#e8a400", label: "JavaScript" },
        { color: "#7c3aed", label: "TSX" }, { color: "#ea580c", label: "JSX" }].map(({ color, label }) => (
          <div key={label} className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: color }} />
            <span style={{ color: "#e6edf3" }}>{label}</span>
          </div>
        ))}
        <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full" style={{ background: "#22c55e" }} /><span style={{ color: "#e6edf3" }}>Entry Point</span></div>
        <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full border border-dashed" style={{ borderColor: "#22c55e" }} /><span style={{ color: "#e6edf3" }}>Test file</span></div>
        <div className="flex items-center gap-2"><span className="w-3 h-0.5" style={{ background: "#f85149", borderTop: "2px dashed #f85149" }} /><span style={{ color: "#e6edf3" }}>Circular Dep</span></div>
        <div className="flex items-center gap-2"><svg width="12" height="12" viewBox="0 0 20 20"><path d="M10 0L20 10L10 20L0 10Z" fill="#6b7280" /></svg><span style={{ color: "#e6edf3" }}>Config</span></div>
        <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full border border-dashed" style={{ borderColor: "#f85149", opacity: 0.5 }} /><span style={{ color: "#e6edf3" }}>Dead Code</span></div>
        <div className="flex items-center gap-2 pt-1" style={{ borderTop: "1px solid #30363d", marginTop: "4px" }}>
          <span className="w-3 h-0.5 rounded" style={{ background: "#f0883e" }} /><span style={{ color: "#e6edf3" }}>Selected</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-0.5 rounded" style={{ background: "#58a6ff" }} /><span style={{ color: "#e6edf3" }}>Hovered</span>
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
      <div ref={containerRef} className="w-full h-full overflow-hidden"
        style={{ background: "#0d1117" }} />
    </div>
  );
}
