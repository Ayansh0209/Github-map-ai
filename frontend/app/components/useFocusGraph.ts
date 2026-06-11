import { useEffect } from "react";
import * as d3 from "d3";
import type { FileNodeDTO, ImportEdgeDTO } from "../lib/types";
import { getLanguageColor, getFolderGroup } from "../lib/graphHelpers";
import { SimNode, SimLink, getRadius, trunc } from "./graphTypes";

export function useFocusGraph({
  focusedNodeId,
  containerRef,
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
}: {
  focusedNodeId: string | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  simulationRef: React.MutableRefObject<d3.Simulation<SimNode, SimLink> | null>;
  svgRef: React.MutableRefObject<d3.Selection<SVGSVGElement, unknown, null, undefined> | null>;
  gRef: React.MutableRefObject<d3.Selection<SVGGElement, unknown, null, undefined> | null>;
  files: FileNodeDTO[];
  edges: ImportEdgeDTO[];
  focusDepth: 1 | 2 | "all";
  focusSearch: string;
  expandedFolders: Set<string>;
  onFileClickRef: React.MutableRefObject<(file: FileNodeDTO | null) => void>;
  setFocusedNodeId: (id: string | null) => void;
  setFocusDepth: (depth: 1 | 2 | "all") => void;
  setExpandedFolders: React.Dispatch<React.SetStateAction<Set<string>>>;
  representativeFilesSet: Set<string>;
}) {
  useEffect(() => {
    if (!focusedNodeId || !containerRef.current) return;

    simulationRef.current?.stop();
    const container = containerRef.current;

    d3.select(container).selectAll("*").remove();

    const width = container.clientWidth || 900;
    const height = container.clientHeight || 600;
    const centerX = width / 2;
    const centerY = height / 2;

    const inDegrees = new Map<string, number>();
    const outDegrees = new Map<string, number>();
    for (const e of edges) {
      inDegrees.set(e.target, (inDegrees.get(e.target) || 0) + 1);
      outDegrees.set(e.source, (outDegrees.get(e.source) || 0) + 1);
    }
    const getImportance = (f: FileNodeDTO) => (inDegrees.get(f.id) || 0) * 1.2 + (outDegrees.get(f.id) || 0) * 1.0 + (representativeFilesSet.has(f.id) ? 5 : 0);

    const hopMap = new Map<string, number>();
    hopMap.set(focusedNodeId, 0);
    const leftIds = new Set<string>();
    const rightIds = new Set<string>();
    const visited = new Set<string>([focusedNodeId]);

    const collect = (targetId: string, currentHop: number, side: 'left' | 'right' | 'center') => {
      const maxHop = focusDepth === "all" ? 10 : focusDepth;
      if (currentHop >= maxHop) return;

      for (const e of edges) {
        if (e.source === targetId && !visited.has(e.target)) {
          if (side === 'center' || side === 'left') {
            hopMap.set(e.target, currentHop + 1);
            leftIds.add(e.target);
            visited.add(e.target);
            collect(e.target, currentHop + 1, 'left');
          }
        }
        if (e.target === targetId && !visited.has(e.source)) {
          if (side === 'center' || side === 'right') {
            hopMap.set(e.source, currentHop + 1);
            rightIds.add(e.source);
            visited.add(e.source);
            collect(e.source, currentHop + 1, 'right');
          }
        }
      }
    };
    collect(focusedNodeId, 0, 'center');

    const centerFile = files.find(f => f.id === focusedNodeId);
    if (!centerFile) return;

    const totalPotentialNodes = visited.size;
    const forceCluster = focusDepth === "all" && totalPotentialNodes > 150;

    const buildNodes = (ids: Set<string>): SimNode[] => {
      const colFiles = files.filter(f => ids.has(f.id));
      const byFolder = new Map<string, FileNodeDTO[]>();
      colFiles.forEach(f => {
        const folder = getFolderGroup(f.id);
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder)!.push(f);
      });

      const result: SimNode[] = [];
      byFolder.forEach((folderFiles, folder) => {
        const isExpanded = !forceCluster && (expandedFolders.has(folder) || folderFiles.length <= 6);
        if (isExpanded) {
          folderFiles.forEach(f => result.push({ id: f.id, data: f, folder, degree: 0, isHub: false, importance: getImportance(f), hop: hopMap.get(f.id) }));
        } else {
          const avgHop = Math.round(folderFiles.reduce((a, f) => a + (hopMap.get(f.id) || 1), 0) / folderFiles.length);
          result.push({ id: `folder:${folder}`, data: { ...folderFiles[0], label: folder, path: folder, kind: "folder" } as any, folder, degree: 0, isHub: true, importance: 0, isGroup: true, childCount: folderFiles.length, hop: avgHop });
        }
      });
      return result;
    };

    const leftNodes = buildNodes(leftIds);
    const rightNodes = buildNodes(rightIds);
    const centerNode: SimNode = {
      id: centerFile.id, data: centerFile, folder: getFolderGroup(centerFile.id),
      degree: 0, isHub: false, importance: getImportance(centerFile), hop: 0,
      x: centerX, y: centerY, fx: centerX, fy: centerY
    };

    const nodes = [centerNode, ...leftNodes, ...rightNodes];
    const nodeLookup = new Map(nodes.map(n => [n.id, n]));

    const isTree = focusDepth === 2 || focusDepth === "all";

    const applyLayout = () => {
      if (!isTree) {
        const layoutSemi = (colNodes: SimNode[], isLeft: boolean) => {
          const byHop = d3.groups(colNodes, n => n.hop || 1);
          byHop.forEach(([hop, hopNodes]) => {
            const radius = 240 * hop;
            const angleSpan = Math.PI * 0.7;
            const startAngle = isLeft ? Math.PI - angleSpan / 2 : -angleSpan / 2;
            const step = hopNodes.length > 1 ? angleSpan / (hopNodes.length - 1) : 0;
            hopNodes.sort((a, b) => (b.importance || 0) - (a.importance || 0)).forEach((n, i) => {
              const angle = startAngle + i * step;
              n.x = centerX + radius * Math.cos(angle);
              n.y = centerY + radius * Math.sin(angle);
            });
          });
        };
        layoutSemi(leftNodes, true);
        layoutSemi(rightNodes, false);
      } else {
        // Readability: min 36px row spacing (was 22 — labels overlapped into
        // an unreadable wall) and giant hops wrap into multiple sub-columns
        // instead of one endless line.
        const MAX_PER_COLUMN = 22;
        const SUB_COLUMN_GAP = 170;
        const layoutTree = (colNodes: SimNode[], isLeft: boolean) => {
          const byHop = d3.groups(colNodes, n => n.hop || 1);
          // horizontal room each hop needs = its own sub-columns
          let xOffset = 0;
          byHop.sort((a, b) => a[0] - b[0]).forEach(([_hop, hopNodes]) => {
            const subCols = Math.ceil(hopNodes.length / MAX_PER_COLUMN);
            const baseX = isLeft
              ? centerX - 220 - xOffset
              : centerX + 220 + xOffset;

            const sorted = hopNodes.sort((a, b) => (b.importance || 0) - (a.importance || 0));
            sorted.forEach((n, i) => {
              const col = Math.floor(i / MAX_PER_COLUMN);
              const row = i % MAX_PER_COLUMN;
              const rowsInCol = Math.min(MAX_PER_COLUMN, hopNodes.length - col * MAX_PER_COLUMN);
              const vSpacing = Math.max(36, Math.min(56, 800 / rowsInCol));
              const startY = centerY - ((rowsInCol - 1) * vSpacing) / 2;
              n.x = baseX + (isLeft ? -1 : 1) * col * SUB_COLUMN_GAP;
              n.y = startY + row * vSpacing;
            });

            xOffset += subCols * SUB_COLUMN_GAP + 40;
          });
        };
        layoutTree(leftNodes, true);
        layoutTree(rightNodes, false);
      }
    };
    applyLayout();

    const svg = d3.select(container).append("svg").attr("width", "100%").attr("height", "100%").attr("viewBox", `0 0 ${width} ${height}`).style("opacity", "0");
    svgRef.current = svg;

    const defs = svg.append("defs");
    defs.append("marker").attr("id", "arrow-dependency").attr("viewBox", "0 -5 10 10").attr("refX", 8).attr("refY", 0).attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto").append("path").attr("d", "M0,-4L10,0L0,4").attr("fill", "#58a6ff");
    defs.append("marker").attr("id", "arrow-dependent").attr("viewBox", "0 -5 10 10").attr("refX", 8).attr("refY", 0).attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto").append("path").attr("d", "M0,-4L10,0L0,4").attr("fill", "#f87171");

    const g = svg.append("g");
    gRef.current = g;
    const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.1, 8]).on("zoom", ev => g.attr("transform", ev.transform));
    svg.call(zoom);

    const links: SimLink[] = [];
    edges.forEach(e => {
      let s = e.source, t = e.target;
      if (!nodeLookup.has(s)) { const f = getFolderGroup(s); if (nodeLookup.has(`folder:${f}`)) s = `folder:${f}`; }
      if (!nodeLookup.has(t)) { const f = getFolderGroup(t); if (nodeLookup.has(`folder:${f}`)) t = `folder:${f}`; }
      if (nodeLookup.has(s) && nodeLookup.has(t)) {
        links.push({ source: s as any, target: t as any, data: e });
      }
    });

    const diagonal = d3.linkHorizontal<any, any>().x(d => d.x).y(d => d.y);
    const baseEdgeOpacity = Math.max(0.15, 0.45 - (nodes.length / 200) * 0.2);

    // Single source of truth for node radius — also used to shorten edges so
    // arrowheads land exactly on the node boundary
    const nodeR = (d: SimNode): number => {
      let r = 7;
      if (d.id === focusedNodeId) r = 18;
      else if (representativeFilesSet.has(d.id)) r = 14;
      else if (d.isGroup) r = 10;
      else if (d.importance > 12) r = 9;
      if (d.hop && d.hop > 1) r *= 0.85;
      return r;
    };

    const shortenedEndpoints = (sNode: SimNode, tNode: SimNode) => {
      const sx = sNode.x ?? 0, sy = sNode.y ?? 0, tx = tNode.x ?? 0, ty = tNode.y ?? 0;
      const dx = tx - sx, dy = ty - sy;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const sr = nodeR(sNode) + 2;
      const tr = nodeR(tNode) + 7;
      return {
        source: { x: sx + (dx / dist) * sr, y: sy + (dy / dist) * sr },
        target: { x: tx - (dx / dist) * tr, y: ty - (dy / dist) * tr },
      };
    };

    const link = g.append("g").selectAll("path").data(links).join("path")
      .attr("d", d => {
        const s = nodeLookup.get(typeof d.source === "string" ? d.source : (d.source as any).id)!;
        const t = nodeLookup.get(typeof d.target === "string" ? d.target : (d.target as any).id)!;
        return diagonal(shortenedEndpoints(s, t));
      })
      .attr("fill", "none")
      .attr("stroke", d => {
        const tid = typeof d.target === 'string' ? d.target : (d.target as any).id;
        const sid = typeof d.source === 'string' ? d.source : (d.source as any).id;
        if (tid === focusedNodeId || leftIds.has(tid)) return "#58a6ff"; 
        return "#f87171"; 
      })
      .attr("stroke-width", 1)
      .attr("stroke-opacity", d => {
        const s = nodeLookup.get(typeof d.source === "string" ? d.source : (d.source as any).id)!;
        const t = nodeLookup.get(typeof d.target === "string" ? d.target : (d.target as any).id)!;
        return (s.hop && s.hop > 1) || (t.hop && t.hop > 1) ? baseEdgeOpacity * 0.5 : baseEdgeOpacity;
      })
      .attr("marker-end", d => {
        const tid = typeof d.target === 'string' ? d.target : (d.target as any).id;
        const sid = typeof d.source === 'string' ? d.source : (d.source as any).id;
        if (tid === focusedNodeId || leftIds.has(tid)) return "url(#arrow-dependency)";
        return "url(#arrow-dependent)";
      });

    const tooltip = d3.select(container).append("div").style("position", "absolute").style("background", "rgba(13,17,23,0.95)").style("border", "1px solid #30363d").style("border-radius", "8px").style("padding", "8px 12px").style("font-size", "12px").style("color", "#e6edf3").style("pointer-events", "none").style("opacity", "0").style("z-index", "100");

    const nodeG = g.append("g").selectAll("g").data(nodes).join("g").attr("transform", d => `translate(${d.x}, ${d.y})`).style("cursor", "pointer");

    nodeG.each(function (d) {
      const g2 = d3.select(this);
      const isFocused = d.id === focusedNodeId;
      const isSearchMatch = !focusSearch || d.data.label.toLowerCase().includes(focusSearch.toLowerCase()) || d.folder.toLowerCase().includes(focusSearch.toLowerCase());
      const hopOpacity = d.hop && d.hop > 1 ? 0.5 : 1;

      const r = nodeR(d);

      if (isFocused) {
        g2.append("circle").attr("r", r + 18).attr("fill", "none").attr("stroke", "#f0883e").attr("stroke-width", 3).attr("stroke-opacity", 0.25).attr("class", "glow");
        g2.append("circle").attr("r", r + 10).attr("fill", "none").attr("stroke", "#f0883e").attr("stroke-width", 1.5).attr("stroke-opacity", 0.4);
      }

      const circle = g2.append("circle").attr("r", r)
        .attr("fill", isFocused ? "#f0883e" : (d.isGroup ? "#30363d" : (representativeFilesSet.has(d.id) ? "#22c55e" : getLanguageColor(d.data.language))))
        .attr("stroke", isFocused ? "#f0883e" : "#0d1117").attr("stroke-width", 1.5)
        .attr("opacity", isSearchMatch ? hopOpacity : 0.12);

      if (d.isGroup) g2.append("text").attr("text-anchor", "middle").attr("dy", "0.35em").attr("fill", "#8b949e").attr("font-size", "9px").attr("font-weight", "bold").text("📁");

      const labelText = d.isGroup ? `/${d.data.label} (${d.childCount})` : d.data.label;
      const label = g2.append("g").attr("transform", `translate(0, ${r + 20})`);
      label.append("text").attr("text-anchor", "middle")
        .attr("fill", isFocused ? "#f0883e" : "#e6edf3").attr("font-size", r > 10 ? "12px" : "10px").attr("font-family", "monospace")
        .attr("opacity", isSearchMatch ? hopOpacity : 0.1)
        .text(trunc(labelText, isTree ? 25 : 20));
    });

    nodeG.on("mouseover", function (ev, d) {
      tooltip.style("opacity", "1").html(d.isGroup ? `<strong>Folder: ${d.folder}</strong><br/>${d.childCount} files` : `<strong>${d.data.label}</strong><br/>${d.data.path}`).style("left", (ev.offsetX + 10) + "px").style("top", (ev.offsetY - 10) + "px");
      const neighborhood = new Set([d.id]);
      links.forEach(l => {
        const sid = typeof l.source === "string" ? l.source : (l.source as any).id;
        const tid = typeof l.target === "string" ? l.target : (l.target as any).id;
        if (sid === d.id) neighborhood.add(tid); if (tid === d.id) neighborhood.add(sid);
      });
      nodeG.transition().duration(120).style("opacity", n => neighborhood.has(n.id) ? 1 : 0.08);
      link.transition().duration(120).attr("stroke-opacity", l => {
        const sid = typeof l.source === "string" ? l.source : (l.source as any).id;
        const tid = typeof l.target === "string" ? l.target : (l.target as any).id;
        return (sid === d.id || tid === d.id) ? 1 : 0.03;
      }).attr("stroke-width", l => {
        const sid = typeof l.source === "string" ? l.source : (l.source as any).id;
        const tid = typeof l.target === "string" ? l.target : (l.target as any).id;
        return (sid === d.id || tid === d.id) ? 2.5 : 0.8;
      });
    }).on("mouseout", function () {
      tooltip.style("opacity", "0");
      nodeG.transition().duration(120).style("opacity", 1);
      link.transition().duration(120).attr("stroke-opacity", l => {
        const s = nodeLookup.get(typeof l.source === "string" ? l.source : (l.source as any).id)!;
        const t = nodeLookup.get(typeof l.target === "string" ? l.target : (l.target as any).id)!;
        const isSecondHop = (s?.hop && s.hop > 1) || (t?.hop && t.hop > 1);
        return isSecondHop ? baseEdgeOpacity * 0.5 : baseEdgeOpacity;
      }).attr("stroke-width", 1);
    }).on("click", (_ev, d) => {
      if (d.isGroup) { setExpandedFolders((prev: Set<string>) => { const n = new Set(prev); if (n.has(d.folder)) n.delete(d.folder); else n.add(d.folder); return n; }); }
      else { onFileClickRef.current(d.data); if (d.id !== focusedNodeId) { setFocusedNodeId(d.id); setFocusDepth(1); } }
    });

    svg.transition().duration(300).style("opacity", "1");
    return () => { simulationRef.current?.stop(); };
  }, [focusedNodeId, files, edges, focusDepth, focusSearch, expandedFolders]); 
}
