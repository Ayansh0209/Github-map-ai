// The unified graph schema — every parser outputs this format
// Never change field names — frontend, cache, and storage all depend on this shape

export type Language = "typescript" | "javascript" | "unknown";

export type ParseStatus = "full" | "imports-only" | "skipped";

export type FunctionKind =
    | "function"        // function foo() {}
    | "arrow"           // const foo = () => {}
    | "method"          // class method
    | "constructor"     // class constructor()
    | "getter"          // get foo()
    | "setter"          // set foo()
    | "async"           // async function or async arrow
    | "middleware"      // (req, res, next) signature
    | "route-handler"   // passed to app.get/router.post etc
    | "test"            // it() test() describe() blocks
    | "unknown";

// Visibility modifier — from class context
export type Visibility = "public" | "private" | "protected";

// What kind of file this is
export type FileKind =
    | "source"
    | "test"
    | "config"
    | "declaration"
    | "ui"              // .jsx/.tsx with capital-letter exports
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
    isAsync?: boolean;             // whether the function uses async/await
    kind: FunctionKind;
    visibility?: Visibility;       // only set for class methods
    parentId?: string;             // parent class ID if inside a class

    calls: string[];        // FunctionNode IDs this function calls
    calledBy: string[];     // FunctionNode IDs that call this — filled in by builder
    testCoveredFiles?: string[];   // if kind === "test", the source files this test covers
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

    // ── Phase 2 additions (optional for backward compatibility) ───────────────
    testSuites?: string[];         // test suite names (describe blocks)
    testCases?: string[];          // individual test names (it/test blocks)
    cycleScore?: number;           // severity of circular dependencies involving this file
    hubScore?: number;             // architectural centrality/hub score
    architecturalImportance?: number; // overall architectural weight
}

export interface ImportEdge {
    source: string;         // FileNode ID
    target: string;         // FileNode ID
    kind: "static" | "dynamic" | "re-export";
    symbols: string[];      // what was imported e.g. ["useState", "useEffect"]
    isTypeOnly: boolean;

    // ── Phase 2 additions ─────────────────────────────────────────────────────
    weight?: number;        // importance of this dependency link
    isCircular?: boolean;   // true if this edge participates in a cycle
    isTestCoverage?: boolean; // true if this is a test file importing its source
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