"use client";

import { useEffect, useRef, useState, memo, useMemo } from "react";
import * as d3 from "d3";
import dagre from "dagre";
import type { FileNodeDTO, ImportEdgeDTO, RepoModuleDTO } from "../lib/types";
import { getLanguageColor, getFolderGroup } from "../lib/graphHelpers";
import { SimNode, SimLink, getRadius, trunc, brightenColor } from "./graphTypes";

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
  modules?: RepoModuleDTO[];
}

import FocusExplorer from "./FocusExplorer";
import { useFocusGraph } from "./useFocusGraph";
// import { SimNode, SimLink, getRadius, brightenColor, trunc } from "./graphTypes";

function getDominantLanguageColor(nodes: SimNode[]): string {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.data.language, (counts.get(n.data.language) || 0) + 1);
  let maxLang = "unknown", maxCount = 0;
  for (const [lang, count] of counts) if (count > maxCount) { maxLang = lang; maxCount = count; }
  return getLanguageColor(maxLang);
}



function FileGraph({
  files, edges, onFileClick, searchQuery, selectedFileId, resetZoomRef, highlightedIssueFiles = new Map(),
  focusMode = false, zoomToNodeRef, filteredNodeIds, modules = [],
}: FileGraphProps) {
  const mainContainerRef = useRef<HTMLDivElement>(null);
  const focusContainerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<d3.Selection<SVGSVGElement, unknown, null, undefined> | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const gRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const nodeGRef = useRef<d3.Selection<SVGGElement, SimNode, SVGGElement, unknown> | null>(null);
  const linkRef = useRef<d3.Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null>(null);
  const simulationRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);

  // Caching
  const mainGraphRef = useRef<{ nodes: SimNode[], links: SimLink[] } | null>(null);
  const lastFilesRef = useRef<FileNodeDTO[]>([]);
  const lastEdgesRef = useRef<ImportEdgeDTO[]>([]);

  const autoFittedRef = useRef(false);
  const onFileClickRef = useRef(onFileClick);
  const selectedFileIdRef = useRef(selectedFileId);
  const [error, setError] = useState<string | null>(null);
  const [isLegendOpen, setIsLegendOpen] = useState(true);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const allFilesRef = useRef(files);
  const allEdgesRef = useRef(edges);
  useEffect(() => { allFilesRef.current = files; allEdgesRef.current = edges; }, [files, edges]);

  // ── Focus mode states ───────────────────────────────────────────────────────
  const [focusDepth, setFocusDepth] = useState<1 | 2 | "all">(1);
  const [focusSearch, setFocusSearch] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [isFocusUIOpen, setIsFocusUIOpen] = useState(true);

  // ── UX Persistence Refs ─────────────────────────────────────────────────────
  const hasAnimatedRef = useRef(false);
  const zoomStateRef = useRef<d3.ZoomTransform | null>(null);
  const mainGraphZoomBeforeFocusRef = useRef<d3.ZoomTransform | null>(null);

  useEffect(() => { onFileClickRef.current = onFileClick; }, [onFileClick]);
  const representativeFilesSet = useMemo(() => {
    const set = new Set<string>();
    modules.forEach((m: RepoModuleDTO) => {
      if (m.representativeFiles) {
        m.representativeFiles.forEach((f: string) => set.add(f));
      }
    });
    return set;
  }, [modules]);

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
        if (representativeFilesSet.has(d.id)) return "#22c55e";
        if (d.data.isDeadCode) return "#30363d";
        return d.isHub ? brightenColor(getLanguageColor(d.data.language)) : getLanguageColor(d.data.language);
      });

    if (highlightedIssueFiles.size > 0) {
      nodeGRef.current
        .filter((d: SimNode) => highlightedIssueFiles.has(d.id))
        .select<SVGCircleElement>(".issue-ring")
        .each(function (d: SimNode) {
          const confidence = highlightedIssueFiles.get(d.id) ?? 50;
          const strokeWidth = confidence >= 80 ? 3 : confidence >= 50 ? 2 : 1;
          const opacity = confidence >= 80 ? 1.0 : confidence >= 50 ? 0.8 : 0.6;
          d3.select(this)
            .attr("r", getRadius(d, representativeFilesSet) + 10)
            .attr("stroke-width", strokeWidth)
            .attr("stroke-opacity", opacity)
            .attr("fill-opacity", 0.1);
        });
    }
  }, [highlightedIssueFiles, representativeFilesSet]);

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
      const container = mainContainerRef.current;
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
        .attr("r", (d: SimNode) => getRadius(d, representativeFilesSet) + 7)
        .attr("stroke-opacity", 1);
    }
  }, [selectedFileId, representativeFilesSet]);

  // ── Main graph build ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mainContainerRef.current || files.length === 0) return;

    // Cache check: only rebuild if files/edges actually changed
    const dataChanged = lastFilesRef.current !== files || lastEdgesRef.current !== edges;
    lastFilesRef.current = files;
    lastEdgesRef.current = edges;

    if (!dataChanged && mainGraphRef.current) {
      // Restore logic: if we just came back from focus mode, the graph is already in mainContainerRef
      // Stop simulation if entering focus mode
      if (focusedNodeId) simulationRef.current?.stop();
      return;
    }

    autoFittedRef.current = false;

    // Preserve existing node positions
    const previousNodes = new Map<string, SimNode>();
    simulationRef.current?.nodes().forEach(n => previousNodes.set(n.id, n));

    simulationRef.current?.stop();
    d3.select(mainContainerRef.current).selectAll("*").remove();
    setError(null);

    const container = mainContainerRef.current;
    const width = container.clientWidth || 900;
    const height = container.clientHeight || 600;

    try {
      // 1. Precompute degrees and importance
      const inDegrees = new Map<string, number>();
      const outDegrees = new Map<string, number>();
      const degreeMap = new Map<string, number>();

      for (const e of edges) {
        inDegrees.set(e.target, (inDegrees.get(e.target) || 0) + 1);
        outDegrees.set(e.source, (outDegrees.get(e.source) || 0) + 1);
        degreeMap.set(e.source, (degreeMap.get(e.source) || 0) + 1);
        degreeMap.set(e.target, (degreeMap.get(e.target) || 0) + 1);
      }

      const getImportance = (f: FileNodeDTO) => (inDegrees.get(f.id) || 0) * 1.2 + (outDegrees.get(f.id) || 0) * 1.0 + (representativeFilesSet.has(f.id) ? 5 : 0);

      const sorted = [...degreeMap.values()].sort((a, b) => b - a);
      const top20Threshold = sorted[Math.floor(sorted.length * 0.20)] ?? 3;

      // 2. Build nodes
      const nodeMap = new Map<string, SimNode>();
      const nodes: SimNode[] = files.map(f => {
        const deg = degreeMap.get(f.id) || 0;
        const prev = previousNodes.get(f.id);
        const n: SimNode = {
          id: f.id,
          data: f,
          folder: getFolderGroup(f.id),
          degree: deg,
          isHub: deg >= top20Threshold && deg > 0,
          importance: getImportance(f),
          x: prev?.x,
          y: prev?.y,
          vx: prev?.vx,
          vy: prev?.vy
        };
        nodeMap.set(f.id, n);
        return n;
      });
      const links: SimLink[] = edges
        .filter(e => nodeMap.has(e.source) && nodeMap.has(e.target))
        .map(e => ({ source: e.source, target: e.target, data: e }));

      // 3. Hierarchical layout using dagre
      const gDagre = new dagre.graphlib.Graph();
      gDagre.setGraph({
        rankdir: "TB",
        nodesep: 90,
        ranksep: 90,
        marginx: 40,
        marginy: 40,
      });
      gDagre.setDefaultEdgeLabel(() => ({}));

      // Detect cycles with simple DFS back-edge detection
      const adj = new Map<string, string[]>();
      for (const e of edges) {
        if (!adj.has(e.source)) adj.set(e.source, []);
        adj.get(e.source)!.push(e.target);
      }
      const visited = new Set<string>();
      const onStack = new Set<string>();
      const backEdges = new Set<string>();

      const dfs = (u: string) => {
        visited.add(u);
        onStack.add(u);
        for (const v of adj.get(u) || []) {
          if (onStack.has(v)) {
            backEdges.add(`${u}->${v}`);
          } else if (!visited.has(v)) {
            dfs(v);
          }
        }
        onStack.delete(u);
      };
      // Start DFS from core files first, then others
      files.filter(f => representativeFilesSet.has(f.id)).forEach(f => { if (!visited.has(f.id)) dfs(f.id); });
      files.forEach(f => { if (!visited.has(f.id)) dfs(f.id); });

      let disconnectedIndex = 0;
      files.forEach(f => {
        if (f.parseStatus !== "skipped") {
          const n = nodeMap.get(f.id);
          if (n) {
            gDagre.setNode(f.id, {
              width: getRadius(n, representativeFilesSet) * 2 + 10,
              height: getRadius(n, representativeFilesSet) * 2 + 10,
            });
          }
        }
      });

      links.forEach(l => {
        const s = l.source as string;
        const t = l.target as string;
        if (!backEdges.has(`${s}->${t}`)) {
          gDagre.setEdge(s, t);
        } else {
          l.data.isCircular = true;
        }
      });

      try {
        dagre.layout(gDagre);
        const isolated = nodes.filter(n => n.degree === 0);
        const cols = Math.ceil(Math.sqrt(isolated.length || 1));
        const spacingX = 170;
        const spacingY = 120;
        const startX = width * 0.72;
        const startY = height * 0.15;
        let isolatedIndex = 0;

        nodes.forEach(n => {
          if (n.degree === 0) {
            const row = Math.floor(isolatedIndex / cols);
            const col = isolatedIndex % cols;
            n.x = startX + col * spacingX;
            n.y = startY + row * spacingY;
            isolatedIndex++;
          } else {
            const pos = gDagre.node(n.id);
            if (pos) {
              n.x = pos.x;
              n.y = pos.y;
            }
          }
          n.fx = null;
          n.fy = null;
        });
      } catch (err) {
        console.error("Dagre layout failed", err);
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
      // refX 8 + per-tick endpoint shortening = arrowheads always sit exactly
      // at the node's edge, whatever its radius (was refX 22 — arrows were
      // buried inside big nodes and floating outside small ones)
      for (const [id, col] of [["default", "#3d444d"], ["highlight", "#58a6ff"]] as [string, string][]) {
        defs.append("marker").attr("id", `arrow-${id}`).attr("viewBox", "0 -5 10 10")
          .attr("refX", 8).attr("refY", 0).attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto")
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
        .on("zoom", ev => {
          g.attr("transform", ev.transform);
          zoomStateRef.current = ev.transform;
          // Label decluttering: when zoomed out, only hubs/core files keep
          // labels — hundreds of overlapping labels were unreadable noise
          const k = ev.transform.k;
          g.selectAll<SVGGElement, SimNode>("g.node-label")
            .style("display", (d: SimNode) =>
              k >= 0.55 || !d || d.isHub || representativeFilesSet.has(d.id) ? "block" : "none"
            );
        });
      zoomRef.current = zoom;
      svg.call(zoom);

      // Restore zoom transform if we have one
      if (mainGraphZoomBeforeFocusRef.current) {
        svg.call(zoom.transform, mainGraphZoomBeforeFocusRef.current);
        mainGraphZoomBeforeFocusRef.current = null; // consume it
      } else if (zoomStateRef.current) {
        svg.call(zoom.transform, zoomStateRef.current);
      }

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


      const tooltip = d3.select(container).append("div")
        .style("position", "absolute").style("background", "rgba(13,17,23,0.95)")
        .style("border", "1px solid #30363d").style("border-radius", "8px")
        .style("padding", "8px 12px").style("font-size", "12px").style("color", "#e6edf3")
        .style("pointer-events", "none").style("opacity", "0").style("max-width", "260px").style("z-index", "100");

      // 5. Edges
      const link = g.append("g")
        .selectAll<SVGLineElement, SimLink>("line").data(links).join("line")
        .attr("stroke", d => d.data.isGhost ? "#6e7681" : d.data.isCircular ? "#f85149" : d.data.isTypeOnly ? "#1c2128" : "#2d333b")
        .attr("stroke-width", d => d.data.isGhost ? 1 : d.data.isTypeOnly ? 0.5 : Math.max(1, (d.data.weight || 1) * 0.8))
        .attr("stroke-dasharray", d => d.data.isGhost ? "2,6" : d.data.isCircular ? "6,4" : d.data.kind === "dynamic" ? "5,3" : "none")
        .attr("stroke-opacity", d => d.data.isGhost ? 0.5 : d.data.isCircular ? 1 : 0.7)
        .attr("marker-end", d => d.data.isGhost ? null : "url(#arrow-default)");
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
        const r = getRadius(d, representativeFilesSet);
        // Issue highlight ring (orange — confidence-based thickness)
        g2.append("circle").attr("class", "issue-ring").attr("r", 0)
          .attr("fill", "rgba(249,115,22,0.1)").attr("stroke", "#f97316").attr("stroke-width", 2)
          .attr("stroke-opacity", 0).attr("fill-opacity", 0).attr("pointer-events", "none");
        // Selection ring (orange, hidden by default)
        g2.append("circle").attr("class", "sel-ring").attr("r", 0)
          .attr("fill", "none").attr("stroke", "#f0883e").attr("stroke-width", 3.5)
          .attr("stroke-opacity", 0).attr("pointer-events", "none");
        // Hover ring (blue, hidden by default)
        g2.append("circle").attr("class", "hover-ring").attr("r", 0)
          .attr("fill", "none").attr("stroke", "#58a6ff").attr("stroke-width", 1.5)
          .attr("stroke-opacity", 0).attr("pointer-events", "none");

        if (d.data.kind === "config") {
          g2.append("path").attr("d", `M0,${-r} L${r},0 L0,${r} L${-r},0 Z`).attr("fill", "#6b7280");
        } else {
          const circle = g2.append("circle").attr("class", "node-circle").attr("r", r);
          if (representativeFilesSet.has(d.id)) {
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
              .attr("stroke", "#f85149").attr("stroke-width", 1).attr("stroke-opacity", 0.7)
              .attr("stroke-dasharray", "4 2").attr("pointer-events", "none");
          }
        }

        // Label — plain text only, no background box, shown for ALL nodes
        const textLabel = trunc(d.data.label, 20);
        let fontSize = "13px";
        if (representativeFilesSet.has(d.id)) fontSize = "14px";
        else fontSize = "13px";

        const labelGroup = g2.append("g")
          .attr("class", "node-label always-visible")
          .attr("transform", `translate(0, ${r + 18})`)
          .style("pointer-events", "none")
          .attr("opacity", 1);

        labelGroup.append("text")
          .attr("x", 0)
          .attr("y", 0)
          .attr("dy", "0.35em")
          .attr("text-anchor", "middle")
          .attr("fill", "#e6edf3")
          .attr("font-size", fontSize)
          .attr("font-family", "monospace")
          .attr("font-weight", 500)
          .text(d.data.label.length > 22 ? d.data.label.slice(0, 19) + "..." : d.data.label)
          .append("title")
          .text(d.data.path);
      });

      // 7. Interactions
      nodeG
        .on("mouseover", function (ev, d) {
          if (selectedFileIdRef.current) return; // don't hover-highlight if something is locked
          d3.select(this).select(".hover-ring").attr("r", getRadius(d, representativeFilesSet) + 4).attr("stroke-opacity", 0.8);

          const conn = new Set([d.id]);
          links.forEach(l => { const s = (l.source as SimNode).id, t = (l.target as SimNode).id; if (s === d.id) conn.add(t); if (t === d.id) conn.add(s); });
          nodeG.attr("opacity", n => conn.has(n.id) ? 1 : 0.06);
          link.attr("stroke", l => { const s = (l.source as SimNode).id, t = (l.target as SimNode).id; return l.data.isCircular ? "#f85149" : (s === d.id || t === d.id ? "#58a6ff" : "#1c2128"); })
            .attr("stroke-opacity", l => { const s = (l.source as SimNode).id, t = (l.target as SimNode).id; return s === d.id || t === d.id ? 1 : 0.03; })
            .attr("marker-end", l => { const s = (l.source as SimNode).id, t = (l.target as SimNode).id; return s === d.id || t === d.id ? "url(#arrow-highlight)" : "url(#arrow-default)"; });
          tooltip.style("opacity", "1")
            .html(`<strong>${d.data.label}</strong><br/><span style="color:#8b949e">${d.data.path}</span><br/>${d.data.language} · ${d.data.lineCount} lines${representativeFilesSet.has(d.id) ? ' · <span style="color:#22c55e">core</span>' : ""}`)
            .style("left", (ev.offsetX + 16) + "px").style("top", (ev.offsetY - 10) + "px");
        })
        .on("mouseout", function (_ev, d) {
          if (selectedFileIdRef.current) return;
          d3.select(this).select(".hover-ring").attr("r", 0).attr("stroke-opacity", 0);

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
        .on("click", (_ev, d) => {
          onFileClickRef.current(d.data);
          setFocusedNodeId(d.id);
        });

      // 8. Simulation
      const sim = d3.forceSimulation<SimNode>(nodes)
        .alpha(0.1)
        .alphaDecay(0.05)
        .velocityDecay(0.6)
        .force("link", d3.forceLink<SimNode, SimLink>(links).id(d => d.id).distance(link =>
          representativeFilesSet.has((link.source as SimNode).id) || representativeFilesSet.has((link.target as SimNode).id) ? 200 : 150
        ))
        .force("charge", d3.forceManyBody<SimNode>().strength(-450))
        .force("collision", d3.forceCollide<SimNode>().radius(d => {
          let r = getRadius(d, representativeFilesSet) + 30;
          if (representativeFilesSet.has(d.id)) r += 50;
          else if (d.isHub) r += 30;
          return r;
        }).iterations(3))
        .force("x", d3.forceX<SimNode>(width / 2).strength(0.01))
        .force("y", d3.forceY<SimNode>(height / 2).strength(0.01))
        .force("center", d3.forceCenter(width / 2, height / 2));
      simulationRef.current = sim;

      if (!hasAnimatedRef.current) {
        sim.alpha(1).restart();
        hasAnimatedRef.current = true;
      } else {
        sim.alpha(0);
      }

      const render = () => {
        link.each(function (d) {
          const sN = d.source as SimNode, tN = d.target as SimNode;
          const sx = sN.x ?? 0, sy = sN.y ?? 0, tx = tN.x ?? 0, ty = tN.y ?? 0;
          const dx = tx - sx, dy = ty - sy;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const sr = getRadius(sN, representativeFilesSet) + 2;
          const tr = getRadius(tN, representativeFilesSet) + 6; // room for the arrowhead
          d3.select(this)
            .attr("x1", sx + (dx / dist) * sr).attr("y1", sy + (dy / dist) * sr)
            .attr("x2", tx - (dx / dist) * tr).attr("y2", ty - (dy / dist) * tr);
        });
        nodeG.attr("transform", d => `translate(${d.x ?? 0},${d.y ?? 0})`);
      };

      sim.on("tick", render);
      // Static first paint from the dagre layout — needed because rebuilds
      // (e.g. after filtering) run with alpha 0 and may never tick
      render();

      sim.on("end", () => {
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
  }, [files, edges, representativeFilesSet]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Search filter ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!nodeGRef.current || !linkRef.current) return;
    const q = searchQuery.toLowerCase().trim();
    if (!q) {
      nodeGRef.current.attr("opacity", 1);
      linkRef.current.attr("stroke-opacity", 0.7);

      nodeGRef.current.select<SVGGElement>("g.node-label")
        .attr("opacity", 1)
        .style("visibility", "visible")
        .classed("label-hidden", false);

      return;
    }
    nodeGRef.current.attr("opacity", (d: SimNode) =>
      d.data.path.toLowerCase().includes(q) || d.data.label.toLowerCase().includes(q) ? 1 : 0.04);
    nodeGRef.current.select<SVGGElement>("g.node-label").attr("opacity", (d: SimNode) =>
      d.data.path.toLowerCase().includes(q) || d.data.label.toLowerCase().includes(q) ? 1 : 0);
    linkRef.current.attr("stroke-opacity", 0.02);
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Focus mode: subgraph extraction + radial re-layout (Delegated) ─────────
  useFocusGraph({
    focusedNodeId,
    containerRef: focusContainerRef,
    simulationRef,
    svgRef,
    gRef,
    files,
    edges,
    focusDepth,
    focusSearch,
    expandedFolders,
    onFileClickRef,
    setFocusedNodeId,
    setFocusDepth,
    setExpandedFolders,
    representativeFilesSet
  });

  // ── Escape key to exit focus mode ───────────────────────────────────────────
  useEffect(() => {
    if (!focusedNodeId) return;
    const handler = (ev: KeyboardEvent) => { if (ev.key === "Escape") setFocusedNodeId(null); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusedNodeId]);

  return (
    <div className="w-full relative flex-1" style={{ height: "100%" }}>
      {/* ── Focus mode banner ───────────────────────────────────────── */}
      {focusedNodeId && (
        <FocusExplorer
          focusedNodeId={focusedNodeId}
          files={files}
          focusDepth={focusDepth}
          setFocusDepth={setFocusDepth}
          focusSearch={focusSearch}
          setFocusSearch={setFocusSearch}
          isFocusUIOpen={isFocusUIOpen}
          setIsFocusUIOpen={setIsFocusUIOpen}
          onExitFocus={() => setFocusedNodeId(null)}
        />
      )}
      <div className="absolute bottom-4 left-4 z-10 border rounded-xl overflow-hidden flex flex-col pointer-events-auto"
        style={{ background: "rgba(13,17,23,0.92)", borderColor: "#30363d" }}>

        <button
          onClick={() => setIsLegendOpen(!isLegendOpen)}
          className="w-full flex items-center justify-between p-3 hover:bg-[rgba(255,255,255,0.05)] transition-colors gap-6"
        >
          <div className="font-semibold text-xs" style={{ color: "#e6edf3" }}>Legend</div>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8b949e" strokeWidth="2" style={{ transform: isLegendOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        {isLegendOpen && (
          <div className="px-3 pb-3 text-xs space-y-1.5 border-t" style={{ borderColor: "#30363d" }}>
            {[{ color: "#3178c6", label: "TypeScript" }, { color: "#e8a400", label: "JavaScript" },
            { color: "#7c3aed", label: "TSX" }, { color: "#ea580c", label: "JSX" }].map(({ color, label }) => (
              <div key={label} className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: color }} />
                <span style={{ color: "#e6edf3" }}>{label}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 mt-1"><span className="w-3 h-3 rounded-full" style={{ background: "#22c55e" }} /><span style={{ color: "#e6edf3" }}>Core File</span></div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full border border-dashed" style={{ borderColor: "#22c55e" }} /><span style={{ color: "#e6edf3" }}>Test file</span></div>
            <div className="flex items-center gap-2"><span className="w-3 h-0.5" style={{ background: "#f85149", borderTop: "2px dashed #f85149" }} /><span style={{ color: "#e6edf3" }}>Circular Dep</span></div>
            <div className="flex items-center gap-2"><span className="w-3 h-0.5" style={{ borderTop: "2px dotted #6e7681" }} /><span style={{ color: "#e6edf3" }}>Via hidden files</span></div>
            <div className="flex items-center gap-2"><svg width="12" height="12" viewBox="0 0 20 20"><path d="M10 0L20 10L10 20L0 10Z" fill="#6b7280" /></svg><span style={{ color: "#e6edf3" }}>Config</span></div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full border border-dashed" style={{ borderColor: "#f85149", opacity: 0.5 }} /><span style={{ color: "#e6edf3" }}>Dead Code</span></div>
            <div className="flex items-center gap-2 pt-1" style={{ borderTop: "1px solid #30363d", marginTop: "4px" }}>
              <span className="w-3 h-0.5 rounded" style={{ background: "#f0883e" }} /><span style={{ color: "#e6edf3" }}>Selected</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-0.5 rounded" style={{ background: "#58a6ff" }} /><span style={{ color: "#e6edf3" }}>Hovered</span>
            </div>
          </div>
        )}
      </div>
      {error && (
        <div className="absolute inset-0 flex items-center justify-center z-20">
          <div className="bg-red-950 border border-red-500 rounded-xl p-6 max-w-md text-center">
            <p className="text-red-300 font-bold mb-2">Graph Error</p>
            <p className="text-red-200 text-xs font-mono">{error}</p>
          </div>
        </div>
      )}
      {/* Main Graph Container */}
      <div
        ref={mainContainerRef}
        className="w-full h-full overflow-hidden"
        style={{
          background: "#0d1117",
          display: focusedNodeId ? "none" : "block"
        }}
      />

      {/* Focus Graph Container */}
      {focusedNodeId && (
        <div
          ref={focusContainerRef}
          className="w-full h-full overflow-hidden absolute inset-0 z-0"
          style={{ background: "#0d1117" }}
        />
      )}
    </div>
  );
}

export default memo(FileGraph);
