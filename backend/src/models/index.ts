// models/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Barrel re-export — every type from every model file is re-exported here.
//
// WHY THIS EXISTS:
//   All existing code imports from "../models/schema" which now lives here.
//   The original schema.ts has been split into focused files for maintainability,
//   but all existing import paths continue to work via this barrel.
//
// IMPORT ORDER:
//   graph.ts       → core graph types (FileNode, FunctionNode, etc.)
//   builder.ts     → builder I/O contracts (BuilderInput, BuilderOutput)
//   search.ts      → search index types (SearchIndex, SearchIndexEntry)
//   issueMapping.ts → issue mapping results (CandidateFile, IssueMappingResult)
//   retrieval.ts   → AI retrieval index (RetrievalIndex, RetrievalFileEntry)
// ─────────────────────────────────────────────────────────────────────────────

export * from "./graph";
export * from "./builder";
export * from "./search";
export * from "./issueMapping";
export * from "./retrieval";
