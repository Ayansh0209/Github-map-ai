"use client";

import { useEffect, useRef, useCallback } from "react";
import * as d3 from "d3";
import type { FileNodeDTO, ImportEdgeDTO } from "../lib/types";
import {
  getLanguageColor,
  getNodeRadius,
  getFolderGroup,
  getEdgeWidth,
  getEdgeDashArray,
} from "../lib/graphHelpers";

interface FileGraphProps {
  files: FileNodeDTO[];
  edges: ImportEdgeDTO[];
  onFileClick: (file: FileNodeDTO) => void;
  owner: string;
  repo: string;
  searchQuery: string;
  selectedFileId: string | null;
}

// ── D3 simulation types ──────────────────────────────────────────────────────

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  data: FileNodeDTO;
  folder: string;
  degree: number;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  data: ImportEdgeDTO;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function FileGraph({
  files,
  edges,
  onFileClick,
  owner,
  repo,
  searchQuery,
  selectedFileId,
}: FileGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const simulationRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  const initializedRef = useRef(false);
  // Store refs for search/selection updates without rebuilding
  const nodeGRef = useRef<d3.Selection<SVGGElement, SimNode, SVGGElement, unknown> | null>(null);
  const linkRef = useRef<d3.Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null>(null);
  const labelRef = useRef<d3.Selection<SVGTextElement, SimNode, SVGGElement, unknown> | null>(null);

  const buildGraph = useCallback(() => {
    if (!containerRef.current || files.length === 0) return;
    if (initializedRef.current) return;
    initializedRef.current = true;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Clear any existing content
    d3.select(container).selectAll("svg").remove();
    d3.select(container).selectAll(".tooltip").remove();

    // Pre-compute degree for each node
    const degreeMap = new Map<string, number>();
    for (const edge of edges) {
      degreeMap.set(edge.source, (degreeMap.get(edge.source) || 0) + 1);
      degreeMap.set(edge.target, (degreeMap.get(edge.target) || 0) + 1);
    }

    // Build nodes
    const nodeMap = new Map<string, SimNode>();
    const nodes: SimNode[] = files.map((f) => {
      const node: SimNode = {
        id: f.id,
        data: f,
        folder: getFolderGroup(f.id),
        degree: degreeMap.get(f.id) || 0,
      };
      nodeMap.set(f.id, node);
      return node;
    });

    // Build links — only if both source and target exist
    const links: SimLink[] = [];
    for (const edge of edges) {
      if (nodeMap.has(edge.source) && nodeMap.has(edge.target)) {
        links.push({
          source: edge.source,
          target: edge.target,
          data: edge,
        });
      }
    }

    // ── SVG setup ─────────────────────────────────────────────────────────

    const svg = d3
      .select(container)
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", [0, 0, width, height]);

    svgRef.current = svg.node();

    // Zoom layer
    const g = svg.append("g");

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 10])
      .on("zoom", (event) => {
        g.attr("transform", event.transform);
      });

    svg.call(zoom);

    // ── Tooltip ───────────────────────────────────────────────────────────

    const tooltip = d3
      .select(container)
      .append("div")
      .attr("class", "tooltip")
      .style("opacity", 0);

    // ── Arrow markers ─────────────────────────────────────────────────────

    const defs = svg.append("defs");

    defs
      .append("marker")
      .attr("id", "arrow-default")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 20)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-4L10,0L0,4")
      .attr("fill", "#30363d");

    defs
      .append("marker")
      .attr("id", "arrow-highlight")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 20)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-4L10,0L0,4")
      .attr("fill", "#58a6ff");

    // ── Links ─────────────────────────────────────────────────────────────

    const link = g
      .append("g")
      .selectAll<SVGLineElement, SimLink>("line")
      .data(links)
      .join("line")
      .attr("class", "graph-link")
      .attr("stroke", "#30363d")
      .attr("stroke-width", (d) => getEdgeWidth(d.data.symbols))
      .attr("stroke-dasharray", (d) => getEdgeDashArray(d.data.kind))
      .attr("stroke-opacity", (d) => (d.data.isTypeOnly ? 0.15 : 0.3))
      .attr("marker-end", "url(#arrow-default)");

    linkRef.current = link;

    // ── Node groups ───────────────────────────────────────────────────────

    const node = g
      .append("g")
      .selectAll<SVGGElement, SimNode>("g")
      .data(nodes)
      .join("g")
      .attr("class", "graph-node")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .call(
        d3
          .drag<SVGGElement, SimNode>()
          .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      );

    nodeGRef.current = node;

    // Entry point ring (drawn first, behind the circle)
    node
      .filter((d) => d.data.isEntryPoint)
      .append("circle")
      .attr("r", (d) => getNodeRadius(d.data.lineCount) + 5)
      .attr("fill", "none")
      .attr("stroke", "#22c55e")
      .attr("stroke-width", 1.5)
      .attr("stroke-opacity", 0.5)
      .attr("stroke-dasharray", "4,3");

    // Main circle
    node
      .append("circle")
      .attr("r", (d) => getNodeRadius(d.data.lineCount))
      .attr("fill", (d) => getLanguageColor(d.data.language))
      .attr("fill-opacity", (d) => {
        if (d.data.kind === "test") return 0.5;
        if (d.data.kind === "config") return 0.6;
        return 0.85;
      })
      .attr("stroke", (d) => {
        if (d.data.kind === "test") return "#22c55e";
        if (d.data.kind === "config") return "#f59e0b";
        return "rgba(255,255,255,0.1)";
      })
      .attr("stroke-width", 1.5);

    // Test file badge "T"
    node
      .filter((d) => d.data.kind === "test")
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .attr("fill", "#22c55e")
      .attr("font-size", "9px")
      .attr("font-weight", "bold")
      .attr("pointer-events", "none")
      .text("T");

    // Labels — always show for entry points and high-degree nodes
    const label = node
      .append("text")
      .attr("class", "graph-label")
      .attr("dy", (d) => getNodeRadius(d.data.lineCount) + 14)
      .attr("text-anchor", "middle")
      .attr("fill", "#e6edf3")
      .attr("font-family", "var(--font-geist-mono), monospace")
      .attr("font-size", "10px")
      .attr("pointer-events", "none")
      .attr("opacity", (d) =>
        d.data.isEntryPoint || d.degree >= 3 ? 1 : 0
      )
      .text((d) => d.data.label);

    labelRef.current = label;

    // ── Interactions ──────────────────────────────────────────────────────

    node
      .on("mouseover", function (event, d) {
        // Show label on hover
        d3.select(this).select("text.graph-label").attr("opacity", 1);

        // Show tooltip
        tooltip
          .style("opacity", 1)
          .html(
            `<strong>${d.data.path}</strong><br/>` +
              `${d.data.language} · ${d.data.lineCount} lines · ${(d.data.sizeBytes / 1024).toFixed(1)}KB<br/>` +
              `${d.data.kind}${d.data.isEntryPoint ? " · entry point" : ""}` +
              `<br/><span style="color:#71717a;font-size:10px">Click to see details & functions</span>`
          )
          .style("left", event.offsetX + 14 + "px")
          .style("top", event.offsetY - 14 + "px");

        // Highlight connected nodes + edges, dim everything else
        const connectedIds = new Set<string>();
        connectedIds.add(d.id);
        links.forEach((l) => {
          const sId = (l.source as SimNode).id;
          const tId = (l.target as SimNode).id;
          if (sId === d.id) connectedIds.add(tId);
          if (tId === d.id) connectedIds.add(sId);
        });

        node.attr("opacity", (n) => (connectedIds.has(n.id) ? 1 : 0.15));
        link
          .attr("stroke", (l) => {
            const s = (l.source as SimNode).id;
            const t = (l.target as SimNode).id;
            return s === d.id || t === d.id ? "#58a6ff" : "#30363d";
          })
          .attr("stroke-opacity", (l) => {
            const s = (l.source as SimNode).id;
            const t = (l.target as SimNode).id;
            return s === d.id || t === d.id ? 0.8 : 0.05;
          })
          .attr("marker-end", (l) => {
            const s = (l.source as SimNode).id;
            const t = (l.target as SimNode).id;
            return s === d.id || t === d.id
              ? "url(#arrow-highlight)"
              : "url(#arrow-default)";
          });
      })
      .on("mouseout", function (_event, d) {
        // Hide label if not always-visible
        if (!d.data.isEntryPoint && d.degree < 3) {
          d3.select(this).select("text.graph-label").attr("opacity", 0);
        }

        tooltip.style("opacity", 0);

        // Reset
        node.attr("opacity", 1);
        link
          .attr("stroke", "#30363d")
          .attr("stroke-opacity", (l) => (l.data.isTypeOnly ? 0.15 : 0.3))
          .attr("marker-end", "url(#arrow-default)");
      })
      .on("click", (_event, d) => {
        onFileClick(d.data);
      });

    // ── Force simulation ──────────────────────────────────────────────────

    // Compute folder centroids for clustering
    const folderSet = new Set(nodes.map((n) => n.folder));
    const folderCenters = new Map<string, { x: number; y: number }>();
    const folderArr = [...folderSet];
    const angleStep = (2 * Math.PI) / Math.max(folderArr.length, 1);
    const clusterRadius = Math.min(width, height) * 0.3;
    folderArr.forEach((f, i) => {
      folderCenters.set(f, {
        x: width / 2 + Math.cos(i * angleStep) * clusterRadius,
        y: height / 2 + Math.sin(i * angleStep) * clusterRadius,
      });
    });

    // Custom folder clustering force
    function folderForce(alpha: number) {
      for (const n of nodes) {
        const center = folderCenters.get(n.folder);
        if (center && n.x != null && n.y != null) {
          n.vx = (n.vx || 0) + (center.x - n.x) * alpha * 0.08;
          n.vy = (n.vy || 0) + (center.y - n.y) * alpha * 0.08;
        }
      }
    }

    const simulation = d3
      .forceSimulation<SimNode>(nodes)
      .force(
        "link",
        d3
          .forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(80)
      )
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(width / 2, height / 2).strength(0.05))
      .force(
        "collision",
        d3
          .forceCollide<SimNode>()
          .radius((d) => getNodeRadius(d.data.lineCount) + 8)
      )
      .force("folder", folderForce)
      .on("tick", () => {
        link
          .attr("x1", (d) => (d.source as SimNode).x!)
          .attr("y1", (d) => (d.source as SimNode).y!)
          .attr("x2", (d) => (d.target as SimNode).x!)
          .attr("y2", (d) => (d.target as SimNode).y!);

        node.attr("transform", (d) => `translate(${d.x},${d.y})`);
      });

    simulationRef.current = simulation;

    // Auto-fit after simulation settles
    simulation.on("end", () => {
      const bounds = (g.node() as SVGGElement)?.getBBox();
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        const dx = bounds.width;
        const dy = bounds.height;
        const cx = bounds.x + dx / 2;
        const cy = bounds.y + dy / 2;
        const scale = 0.85 / Math.max(dx / width, dy / height);
        const translate: [number, number] = [
          width / 2 - cx * scale,
          height / 2 - cy * scale,
        ];
        svg
          .transition()
          .duration(750)
          .call(
            zoom.transform,
            d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale)
          );
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, edges]);

  // ── Search filter effect ────────────────────────────────────────────────
  useEffect(() => {
    if (!nodeGRef.current || !linkRef.current) return;
    const q = searchQuery.toLowerCase().trim();

    if (!q) {
      nodeGRef.current.attr("opacity", 1);
      linkRef.current.attr("stroke-opacity", (d: SimLink) =>
        d.data.isTypeOnly ? 0.15 : 0.3
      );
      // Reset labels
      if (labelRef.current) {
        labelRef.current.attr("opacity", (d: SimNode) =>
          d.data.isEntryPoint || d.degree >= 3 ? 1 : 0
        );
      }
      return;
    }

    nodeGRef.current.attr("opacity", (d: SimNode) =>
      d.data.label.toLowerCase().includes(q) ||
      d.data.path.toLowerCase().includes(q)
        ? 1
        : 0.08
    );

    // Show labels for matches
    if (labelRef.current) {
      labelRef.current.attr("opacity", (d: SimNode) =>
        d.data.label.toLowerCase().includes(q) ||
        d.data.path.toLowerCase().includes(q)
          ? 1
          : 0
      );
    }

    linkRef.current.attr("stroke-opacity", 0.05);
  }, [searchQuery]);

  // ── Selected file highlight ─────────────────────────────────────────────
  useEffect(() => {
    if (!nodeGRef.current) return;

    nodeGRef.current.select("circle:nth-child(2)").attr("stroke", (d: SimNode) => {
      if (d.id === selectedFileId) return "#f0883e";
      if (d.data.kind === "test") return "#22c55e";
      if (d.data.kind === "config") return "#f59e0b";
      return "rgba(255,255,255,0.1)";
    }).attr("stroke-width", (d: SimNode) => (d.id === selectedFileId ? 3 : 1.5));
  }, [selectedFileId]);

  // ── Mount / unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    buildGraph();

    return () => {
      simulationRef.current?.stop();
      initializedRef.current = false;
    };
  }, [buildGraph]);

  return (
    <div className="w-full relative" style={{ height: "75vh" }}>
      {/* Legend */}
      <div
        className="absolute bottom-4 left-4 z-10 border rounded-xl p-3 text-xs space-y-1.5"
        style={{ background: "rgba(13,17,23,0.9)", borderColor: "#30363d" }}
      >
        <div className="font-medium mb-2" style={{ color: "#8b949e" }}>
          Legend
        </div>
        <div className="flex items-center gap-2">
          <span
            className="w-3 h-3 rounded-full"
            style={{ background: "#3178c6" }}
          />
          <span style={{ color: "#e6edf3" }}>TypeScript</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="w-3 h-3 rounded-full border"
            style={{ background: "#f7df1e", borderColor: "#8b7a00" }}
          />
          <span style={{ color: "#e6edf3" }}>JavaScript</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="w-3 h-3 rounded-full"
            style={{ background: "#7c3aed" }}
          />
          <span style={{ color: "#e6edf3" }}>TSX</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="w-3 h-3 rounded-full"
            style={{ background: "#ea580c" }}
          />
          <span style={{ color: "#e6edf3" }}>JSX</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="w-3 h-3 rounded-full border"
            style={{ borderColor: "#22c55e", background: "transparent" }}
          />
          <span style={{ color: "#e6edf3" }}>Test file</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="w-3 h-3 rounded-full border border-dashed"
            style={{ borderColor: "#22c55e", background: "transparent" }}
          />
          <span style={{ color: "#e6edf3" }}>Entry point</span>
        </div>
        <div className="mt-2" style={{ color: "#8b949e" }}>
          Node size = line count
        </div>
        <div style={{ color: "#8b949e" }}>Click file → see functions</div>
      </div>

      {/* Stats overlay */}
      <div
        className="absolute top-4 right-4 z-10 rounded-xl p-3 text-xs space-y-1"
        style={{ background: "rgba(13,17,23,0.9)", borderColor: "#30363d", border: "1px solid #30363d" }}
      >
        <div className="font-medium" style={{ color: "#e6edf3" }}>
          {owner}/{repo}
        </div>
        <div style={{ color: "#8b949e" }}>
          {files.length} files · {edges.length} edges
        </div>
        <div style={{ color: "#484f58" }}>Scroll to zoom · Drag to pan</div>
      </div>

      {/* Graph container */}
      <div
        ref={containerRef}
        className="graph-container w-full h-full rounded-2xl overflow-hidden"
        style={{ background: "#0d1117", border: "1px solid #30363d" }}
      />
    </div>
  );
}
