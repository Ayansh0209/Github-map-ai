// models/search.ts
// ─────────────────────────────────────────────────────────────────────────────
// Search index types — the schema for the pre-built keyword search index
// stored in Redis under search:{owner}:{repo}.
//
// The SearchIndex powers the deterministic keyword-matching step of issue
// mapping (issueMapper.ts / queryEngine.ts). It is separate from the
// RetrievalIndex (retrieval.ts), which is built for AI-driven selection.
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchIndexEntry {
    id: string;                // file path or function ID
    type: "file" | "function" | "export" | "test";
    name: string;              // display name
    filePath: string;          // parent file path
    language?: string;
    kind?: string;             // FileKind or FunctionKind
    isEntryPoint?: boolean;
    isDeadCode?: boolean;
    packageName?: string;      // workspace package
    tokens: string[];          // pre-tokenized search terms
    usageCount?: number;       // number of incoming imports or function calls
    hubScore?: number;         // architectural connectivity score (0-100)
}

export interface SearchIndex {
    entries: SearchIndexEntry[];
    generatedAt: string;
}
