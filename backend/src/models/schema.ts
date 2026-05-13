// models/schema.ts
// ─────────────────────────────────────────────────────────────────────────────
// COMPATIBILITY SHIM — do not add new types here.
//
// This file has been split into focused modules:
//   models/graph.ts        — FileNode, FunctionNode, ImportEdge, CallEdge, GraphData
//   models/builder.ts      — BuilderInput, BuilderOutput
//   models/search.ts       — SearchIndex, SearchIndexEntry
//   models/issueMapping.ts — CandidateFile, CandidateFunction, IssueMappingResult
//   models/retrieval.ts    — RetrievalIndex, RetrievalFileEntry, RetrievalFunction
//
// All existing imports of the form:
//   import { FileNode } from "../models/schema"
// continue to work unchanged via this re-export.
// ─────────────────────────────────────────────────────────────────────────────

export * from "./index";