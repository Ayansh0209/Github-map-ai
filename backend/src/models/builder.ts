// models/builder.ts
// ─────────────────────────────────────────────────────────────────────────────
// Builder input/output types — the contract between the parser pipeline
// and the graph builder.
//
// BuilderInput is what chunkProcessor hands to builder.ts.
// BuilderOutput is what builder.ts returns for storage and serving.
// ─────────────────────────────────────────────────────────────────────────────

import type { FileNode, FunctionNode, ImportEdge, GraphData, FileGraphPayload, FunctionFilePayload } from "./graph";
import type { SearchIndex } from "./search";

// ── Builder input ─────────────────────────────────────────────────────────────

export interface BuilderInput {
    owner: string;
    repo: string;
    commitSha: string;
    fileNodes: FileNode[];
    importEdges: ImportEdge[];
    allFunctions: FunctionNode[];

    // ── Phase 1 additions (optional — entryScorer uses these if present) ──────
    repoRoot?: string;                    // absolute disk path to repo root
    startupSignals?: Map<string, boolean>;      // fileId → hasStartupSignals
    routeHandlers?: Map<string, boolean>;      // fileId → hasRouteHandlers
}

export interface BuilderOutput {
    graphData: GraphData;
    fileGraph: FileGraphPayload;
    functionFiles: Map<string, FunctionFilePayload>;
    searchIndex?: SearchIndex;
}
