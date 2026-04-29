"use client";

import { useEffect, useRef, useCallback } from "react";
import * as d3 from "d3";
import type { FileNodeDTO, ImportEdgeDTO } from "../lib/client";

interface FileGraphProps {
  files: FileNodeDTO[];
  edges: ImportEdgeDTO[];
  onFileClick: (file: FileNodeDTO) => void;
  owner: string;
  repo: string;
}

// ── Color map by language / kind ──────────────────────────────────────────────

const LANGUAGE_COLORS: Record<string, string> = {
  typescript: "#3b82f6",
  javascript: "#eab308",
  tsx: "#8b5cf6",
  jsx: "#f97316",
  json: "#6b7280",
  css: "#ec4899",
  html: "#ef4444",
  unknown: "#6b7280",
};

const KIND_OUTLINE: Record<string, string> = {
  test: "#22c55e",
  config: "#f59e0b",
  declaration: "#06b6d4",
  source: "transparent",
};

function getColor(file: FileNodeDTO): string {
  return LANGUAGE_COLORS[file.language] || LANGUAGE_COLORS.unknown;
}

function getRadius(file: FileNodeDTO): number {
  // Scale by line count: min 4, max 20
  const lines = file.lineCount || 1;
  return Math.max(4, Math.min(20, Math.sqrt(lines) * 0.8));
}

// ── D3 simulation types ──────────────────────────────────────────────────────

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  data: FileNodeDTO;
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
}: FileGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const simulationRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  const initializedRef = useRef(false);

  const buildGraph = useCallback(() => {
    if (!containerRef.current || files.length === 0) return;
    if (initializedRef.current) return;
    initializedRef.current = true;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Clear any existing SVG
    d3.select(container).selectAll("svg").remove();

    // Build nodes
    const nodeMap = new Map<string, SimNode>();
    const nodes: SimNode[] = files.map((f) => {
      const node: SimNode = { id: f.id, data: f };
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
      .scaleExtent([0.1, 8])
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

    // ── Arrows ────────────────────────────────────────────────────────────

    svg
      .append("defs")
      .append("marker")
      .attr("id", "arrow")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 20)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "#3f3f46");

    // ── Links ─────────────────────────────────────────────────────────────

    const link = g
      .append("g")
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("class", "graph-link")
      .attr("stroke", "#27272a")
      .attr("stroke-width", 1)
      .attr("marker-end", "url(#arrow)");

    // ── Nodes ─────────────────────────────────────────────────────────────

    const node = g
      .append("g")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("class", "graph-node")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .call(d3.drag<any, SimNode>()
        .on("start", (event: d3.D3DragEvent<SVGGElement, SimNode, SimNode>, d: SimNode) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on("drag", (event: d3.D3DragEvent<SVGGElement, SimNode, SimNode>, d: SimNode) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on("end", (event: d3.D3DragEvent<SVGGElement, SimNode, SimNode>, d: SimNode) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        })
      );

    // Circle
    node
      .append("circle")
      .attr("r", (d) => getRadius(d.data))
      .attr("fill", (d) => getColor(d.data))
      .attr("fill-opacity", 0.8)
      .attr("stroke", (d) => KIND_OUTLINE[d.data.kind] || "transparent")
      .attr("stroke-width", (d) => (d.data.isEntryPoint ? 2.5 : 1.5));

    // Entry point indicator (inner ring)
    node
      .filter((d) => d.data.isEntryPoint)
      .append("circle")
      .attr("r", (d) => getRadius(d.data) + 4)
      .attr("fill", "none")
      .attr("stroke", (d) => getColor(d.data))
      .attr("stroke-width", 1)
      .attr("stroke-opacity", 0.3)
      .attr("stroke-dasharray", "3,3");

    // Label
    node
      .append("text")
      .attr("class", "graph-label")
      .attr("dy", (d) => getRadius(d.data) + 14)
      .attr("text-anchor", "middle")
      .text((d) => d.data.label);

    // ── Interactions ──────────────────────────────────────────────────────

    node
      .on("mouseover", (event, d) => {
        tooltip
          .style("opacity", 1)
          .html(
            `<strong>${d.data.path}</strong><br/>` +
            `${d.data.language} · ${d.data.lineCount} lines · ${(d.data.sizeBytes / 1024).toFixed(1)}KB<br/>` +
            `${d.data.kind}${d.data.isEntryPoint ? " · entry point" : ""}`
          )
          .style("left", event.offsetX + 12 + "px")
          .style("top", event.offsetY - 12 + "px");

        // highlight connected edges
        link
          .attr("stroke", (l) => {
            const s = (l.source as SimNode).id;
            const t = (l.target as SimNode).id;
            return s === d.id || t === d.id ? "#6366f1" : "#27272a";
          })
          .attr("stroke-opacity", (l) => {
            const s = (l.source as SimNode).id;
            const t = (l.target as SimNode).id;
            return s === d.id || t === d.id ? 0.8 : 0.15;
          });
      })
      .on("mouseout", () => {
        tooltip.style("opacity", 0);
        link.attr("stroke", "#27272a").attr("stroke-opacity", 0.3);
      })
      .on("click", (_event, d) => {
        onFileClick(d.data);
      });

    // ── Simulation ────────────────────────────────────────────────────────

    const simulation = d3
      .forceSimulation<SimNode>(nodes)
      .force(
        "link",
        d3
          .forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(80)
      )
      .force("charge", d3.forceManyBody().strength(-120))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius((d) => getRadius((d as SimNode).data) + 6))
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
      if (bounds) {
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
  }, [files, edges, onFileClick, owner, repo]);

  useEffect(() => {
    buildGraph();

    return () => {
      simulationRef.current?.stop();
      initializedRef.current = false;
    };
  }, [buildGraph]);

  return (
    <div className="w-full relative" style={{ height: "70vh" }}>
      {/* Legend */}
      <div className="absolute top-4 left-4 z-10 bg-surface/90 backdrop-blur border border-border rounded-xl p-3 text-xs space-y-1.5">
        <div className="text-muted font-medium mb-2">Legend</div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-[#3b82f6]" />
          <span>TypeScript</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-[#eab308]" />
          <span>JavaScript</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-[#8b5cf6]" />
          <span>TSX</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-[#f97316]" />
          <span>JSX</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full border border-[#22c55e]" />
          <span>Test file</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full border border-dashed border-muted" />
          <span>Entry point</span>
        </div>
        <div className="text-muted mt-2">Node size = line count</div>
      </div>

      {/* Stats overlay */}
      <div className="absolute top-4 right-4 z-10 bg-surface/90 backdrop-blur border border-border rounded-xl p-3 text-xs space-y-1">
        <div className="text-muted font-medium">{owner}/{repo}</div>
        <div>{files.length} files · {edges.length} edges</div>
        <div className="text-muted">Scroll to zoom · Drag to pan</div>
      </div>

      {/* Graph container */}
      <div
        ref={containerRef}
        className="graph-container w-full h-full bg-background rounded-2xl border border-border overflow-hidden"
      />
    </div>
  );
}
