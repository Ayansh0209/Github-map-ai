// The unified graph schema — every parser outputs this format
// Never change field names — frontend, cache, and storage all depend on this shape

export type Language = "typescript" | "javascript" | "unknown";

export type ParseStatus = "full" | "imports-only" | "skipped";

export type FunctionKind =
    | "function"       // function foo() {}
    | "arrow"          // const foo = () => {}
    | "method"         // class method
    | "constructor"    // class constructor
    | "getter"         // get foo()
    | "setter"         // set foo()
    | "async"          // async function foo()
    | "unknown";

// Visibility modifier — from class context
export type Visibility = "public" | "private" | "protected";

// What kind of file this is
export type FileKind =
    | "source"         // regular source file
    | "test"           // *.test.ts *.spec.ts
    | "config"         // jest.config.ts vite.config.ts etc
    | "declaration"    // *.d.ts
    | "unknown";

// Call edge kind — how the call was made
export type CallKind =
    | "direct"         // foo()
    | "method"         // obj.foo()
    | "async"          // await foo()
    | "unknown";


export interface FunctionNode {
    // "src/utils/parser.ts::parseImports"
    id: string;
    name: string;
    filePath: string;       // relativePath of parent file — matches FileNode.id
    startLine: number;
    endLine: number;
    isExported: boolean;
    kind: FunctionKind;
    visibility?: Visibility;       // only set for class methods
    parentId?: string;             // parent class ID if inside a class

    calls: string[];        // FunctionNode IDs this function calls
    calledBy: string[];     // FunctionNode IDs that call this — filled in by builder
    analysisConfidence: "high" | "medium" | "low";
    // high   = full parse, function extracted cleanly
    // medium = full parse but call resolution partial
    // low    = imports-only or parse error
}

export interface FileNode {
    // relativePath from repo root e.g. "src/utils/parser.ts"
    id: string;            // relativePath from repo root e.g. "src/utils/parser.ts"
    label: string;         // just the filename e.g. "parser.ts"
    language: Language;
    path: string;          // same as id, kept for frontend convenience
    sizeBytes: number;
    lineCount: number;     // total lines — useful for node sizing in D3
    parseStatus: ParseStatus;
    kind: FileKind;
    isEntryPoint: boolean; // derived from entryScore — true when score >= ENTRY_THRESHOLD
    functions: FunctionNode[];
    externalImports: string[];     // react, lodash — no edge, just metadata
    unresolvedImports: string[];   // imports that couldn't be resolved to a file

    // ── Phase 1 additions (optional for backward compatibility) ───────────────
    // Scoring details so the frontend/debugger can explain WHY a file is an entry point
    entryScore?: number;           // weighted score from entryScorer
    entryReasons?: string[];       // human-readable audit trail e.g. ["package.json:main +20", "app.listen() +10"]
}

export interface ImportEdge {
    source: string;         // FileNode ID
    target: string;         // FileNode ID
    kind: "static" | "dynamic" | "re-export";
    symbols: string[];      // what was imported e.g. ["useState", "useEffect"]
    isTypeOnly: boolean;
}

export interface CallEdge {
    source: string;         // FunctionNode ID
    target: string;         // FunctionNode ID
    kind: CallKind;
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
        testFiles: number;
        entryPoints: number;
    };
}

export interface FileGraphPayload {
    repoId: string;
    commitSha: string;
    generatedAt: string;
    stats: GraphData["stats"];
    files: Omit<FileNode, "functions">[];   // no functions array — kept small
    importEdges: ImportEdge[];
}

export interface FunctionFilePayload {
    fileId: string;
    functions: FunctionNode[];
    callEdges: CallEdge[];
}

// ── Builder input ─────────────────────────────────────────────────────────────

export interface BuilderInput {
    owner: string;
    repo: string;
    commitSha: string;
    fileNodes: FileNode[];
    importEdges: ImportEdge[];
    allFunctions: FunctionNode[];

    // ── Phase 1 additions (optional — entryScorer uses these if present) ──────
    repoRoot?:       string;                    // absolute disk path to repo root
    startupSignals?: Map<string, boolean>;      // fileId → hasStartupSignals
    routeHandlers?:  Map<string, boolean>;      // fileId → hasRouteHandlers
}

export interface BuilderOutput {
    graphData: GraphData;
    fileGraph: FileGraphPayload;
    functionFiles: Map<string, FunctionFilePayload>;
}