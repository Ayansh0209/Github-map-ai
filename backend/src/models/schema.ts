// The unified graph schema — every parser outputs this format
// Never change field names — frontend, cache, and storage all depend on this shape

export type Language = "typescript" | "javascript" | "unknown";

export type ParseStatus = "full" | "imports-only" | "skipped";

export interface FunctionNode {
    // "src/utils/parser.ts::parseImports"
    id: string;
    name: string;
    filePath: string;       // relativePath of parent file — matches FileNode.id
    startLine: number;
    endLine: number;
    isExported: boolean;
    calls: string[];        // FunctionNode IDs this function calls
    calledBy: string[];     // FunctionNode IDs that call this — filled in by builder
}

export interface FileNode {
    // relativePath from repo root e.g. "src/utils/parser.ts"
    id: string;
    label: string;          // just the filename e.g. "parser.ts"
    language: Language;
    path: string;           // same as id, kept for frontend convenience
    sizeBytes: number;
    parseStatus: ParseStatus;
    functions: FunctionNode[];
    externalImports: string[]; // react, lodash etc — no edge, just metadata
}

export interface ImportEdge {
    source: string;         // FileNode ID
    target: string;         // FileNode ID
    kind: "static" | "dynamic" | "re-export";
    symbols: string[];      // what was imported e.g. ["useState", "useEffect"]
}

export interface CallEdge {
    source: string;         // FunctionNode ID
    target: string;         // FunctionNode ID
}

export interface GraphData {
    repoId: string;         // "owner/repo"
    commitSha: string;
    files: FileNode[];
    importEdges: ImportEdge[];
    callEdges: CallEdge[];
    generatedAt: string;    // ISO timestamp
    stats: {
        totalFiles: number;
        parsedFiles: number;
        totalFunctions: number;
        totalImportEdges: number;
        totalCallEdges: number;
    };
}