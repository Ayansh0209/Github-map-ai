// src/parser/graphAnalytics.ts
// Graph algorithms to enhance the semantic intelligence of the graph.
// Implements Tarjan's Strongly Connected Components (SCC) for cycle detection
// and a degree-based weighting system for architectural importance.

import { FileNode, ImportEdge } from "../models/schema";

export interface AnalyticsResult {
    // We mutate nodes/edges in-place, but return stats for logging
    cycleCount: number;
    filesInCycles: number;
}

/**
 * Runs all semantic graph analytics on the final graph structures.
 * Mutates `fileNodes` and `importEdges` in-place.
 */
export function applyGraphAnalytics(fileNodes: FileNode[], importEdges: ImportEdge[]): AnalyticsResult {
    const cycleStats = detectCircularDependencies(fileNodes, importEdges);
    calculateDependencyWeights(fileNodes, importEdges);
    return cycleStats;
}

// ── Circular Dependency Detection (Tarjan's SCC Algorithm) ───────────────────

function detectCircularDependencies(fileNodes: FileNode[], importEdges: ImportEdge[]): AnalyticsResult {
    let index = 0;
    const stack: string[] = [];
    const onStack = new Set<string>();
    
    // Metadata per node
    const indices = new Map<string, number>();
    const lowlinks = new Map<string, number>();
    
    // Build adjacency list
    const graph = new Map<string, string[]>();
    for (const node of fileNodes) {
        graph.set(node.id, []);
    }
    for (const edge of importEdges) {
        // Only consider static and re-export edges for strict structural cycles
        if (edge.kind !== "dynamic" && !edge.isTypeOnly) {
            const list = graph.get(edge.source) || [];
            list.push(edge.target);
            graph.set(edge.source, list);
        }
    }

    const sccs: string[][] = [];

    function strongconnect(v: string) {
        indices.set(v, index);
        lowlinks.set(v, index);
        index++;
        stack.push(v);
        onStack.add(v);

        const neighbors = graph.get(v) || [];
        for (const w of neighbors) {
            if (!indices.has(w)) {
                strongconnect(w);
                lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
            } else if (onStack.has(w)) {
                lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
            }
        }

        if (lowlinks.get(v) === indices.get(v)) {
            const scc: string[] = [];
            let w: string;
            do {
                w = stack.pop()!;
                onStack.delete(w);
                scc.push(w);
            } while (w !== v);
            
            // A single node is not a circular dependency (unless it self-imports, which builder catches)
            if (scc.length > 1) {
                sccs.push(scc);
            }
        }
    }

    for (const node of fileNodes) {
        if (!indices.has(node.id)) {
            strongconnect(node.id);
        }
    }

    // Apply cycle data to the nodes and edges
    let filesInCycles = 0;
    
    const cycleNodeSet = new Set<string>();
    for (const scc of sccs) {
        for (const nodeId of scc) {
            cycleNodeSet.add(nodeId);
        }
    }

    for (const node of fileNodes) {
        if (cycleNodeSet.has(node.id)) {
            // Assign a high cycle score if it's in a cycle
            node.cycleScore = 100;
            filesInCycles++;
        } else {
            node.cycleScore = 0;
        }
    }

    for (const edge of importEdges) {
        // An edge is circular if both source and target are in the same SCC
        // and it's not dynamic/type-only.
        if (edge.kind !== "dynamic" && !edge.isTypeOnly && cycleNodeSet.has(edge.source) && cycleNodeSet.has(edge.target)) {
            // Further verify they are in the exact SAME component
            const sourceSCC = sccs.find(c => c.includes(edge.source));
            if (sourceSCC && sourceSCC.includes(edge.target)) {
                edge.isCircular = true;
            }
        }
    }

    return {
        cycleCount: sccs.length,
        filesInCycles
    };
}

// ── Weighted Dependency Scoring ──────────────────────────────────────────────

function calculateDependencyWeights(fileNodes: FileNode[], importEdges: ImportEdge[]) {
    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();

    for (const node of fileNodes) {
        inDegree.set(node.id, 0);
        outDegree.set(node.id, 0);
    }

    for (const edge of importEdges) {
        outDegree.set(edge.source, (outDegree.get(edge.source) || 0) + 1);
        inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
        
        // Edge weight is primarily based on the number of imported symbols.
        // A single bare import (symbols.length === 0) gets a base weight of 1.
        let baseWeight = edge.symbols.length > 0 ? edge.symbols.length : 1;
        
        // Dynamic imports are weaker architecturally
        if (edge.kind === "dynamic") {
            baseWeight *= 0.5;
        }
        
        // Type-only imports don't affect runtime architecture
        if (edge.isTypeOnly) {
            baseWeight *= 0.2;
        }

        edge.weight = Math.round(baseWeight * 10) / 10;
    }

    // Calculate node hub and importance scores
    for (const node of fileNodes) {
        const ins = inDegree.get(node.id) || 0;
        const outs = outDegree.get(node.id) || 0;

        // Hub score: High out-degree means it orchestrates many modules (e.g. a controller or central store)
        // High in-degree means it's a core utility or shared state.
        // A true hub usually has high numbers of both, or massive numbers of one.
        node.hubScore = (ins * 1.5) + (outs * 1.0);
        
        // Architectural importance adds function count and line count signals
        const complexity = (node.functions?.length || 0) * 0.5 + Math.min(node.lineCount * 0.01, 10);
        node.architecturalImportance = Math.round(node.hubScore + complexity);
    }
}
