// models/retrieval.ts
// ─────────────────────────────────────────────────────────────────────────────
// Retrieval index types — a separate, AI-oriented data store built at parse
// time and stored in Redis under retrieval:{owner}:{repo}.
//
// PURPOSE:
//   The RetrievalIndex is NOT for visualization. It is specifically designed
//   to power AI-driven issue mapping and chat. It provides retrieval-oriented
//   signals that tell the AI which files and functions are worth fetching
//   from GitHub's raw content API.
//
// CONTRAST WITH SearchIndex:
//   - SearchIndex: keyword tokens for deterministic BM25-style matching
//   - RetrievalIndex: semantic signals (auth checks, DB calls, barrel status,
//     semantic role) for AI-driven context selection
//
// STORAGE:
//   Key: retrieval:{owner}:{repo}
//   No TTL — the commitSha inside the index handles staleness.
//   If a new analysis runs for the same repo with a different SHA, it overwrites.
// ─────────────────────────────────────────────────────────────────────────────

// ── Semantic role ─────────────────────────────────────────────────────────────
//
// Describes the architectural role of a file in a GraphQL/REST backend.
// Detected heuristically from file path, directory name, and function kinds.
//
// resolver  — GraphQL resolver (e.g. src/resolvers/userResolver.ts)
// mutation  — GraphQL mutation handler (e.g. mutations/createUser.ts)
// query     — GraphQL query handler (e.g. queries/getUser.ts)
// schema    — GraphQL type definitions (e.g. typeDefs, schema.graphql)
// auth      — Authentication/authorization logic (e.g. auth/, middleware/auth)
// middleware — Express/Koa/NestJS middleware (route middleware, guards)
// service   — Business logic service layer (e.g. services/userService.ts)
// controller — HTTP request handler layer (e.g. controllers/userController.ts)
// repository — Data access layer / DAL (e.g. repository/, dao/)
// model     — Data model or ORM entity (e.g. models/, entities/)
// util      — Utility/helper functions (e.g. utils/, helpers/, lib/)
// config    — Configuration, environment, setup
// test      — Test file
// barrel    — Index/barrel file (re-exports only, no implementations)
// unknown   — Could not be determined
export type SemanticRole =
    | "resolver"
    | "mutation"
    | "query"
    | "schema"
    | "auth"
    | "middleware"
    | "service"
    | "controller"
    | "repository"
    | "model"
    | "util"
    | "config"
    | "test"
    | "barrel"
    | "unknown";

// ── RetrievalFunction ─────────────────────────────────────────────────────────
//
// A function entry in the retrieval index. Carries retrieval-oriented signals
// that the AI uses to decide which functions are worth fetching and reading.
export interface RetrievalFunction {
    // ── Identity ──────────────────────────────────────────────────────────────
    id: string;           // same format as FunctionNode.id: "filePath::name"
    name: string;         // function name
    filePath: string;     // parent file's relative path

    // ── Location — used to slice bodies from GitHub raw fetch ─────────────────
    startLine: number;
    endLine: number;

    // ── Structural ────────────────────────────────────────────────────────────
    kind: string;         // FunctionKind string
    isExported: boolean;
    isAsync: boolean;

    // ── Retrieval signals — the core value of this index ──────────────────────
    //
    // hasAuthCheck: true if this function contains authorization/permission logic.
    // The AI uses this to know: "if the issue is about permission denied errors,
    // fetch this function first."
    hasAuthCheck: boolean;
    //
    // hasDatabaseCall: true if this function contains ORM or raw database calls.
    // The AI uses this to know: "if the issue is about data not saving/loading,
    // fetch this function first."
    hasDatabaseCall: boolean;

    // ── Call graph ────────────────────────────────────────────────────────────
    calls: string[];      // resolved FunctionNode IDs this function calls
}

// ── RetrievalFileEntry ────────────────────────────────────────────────────────
//
// A file entry in the retrieval index. Contains the reverse import graph
// (importedBy) and semantic signals the AI uses for file selection.
export interface RetrievalFileEntry {
    // ── Identity ──────────────────────────────────────────────────────────────
    fileId: string;       // same as FileNode.id: relative path from repo root

    // ── Barrel detection ──────────────────────────────────────────────────────
    //
    // A barrel file re-exports from other files but contains no implementations.
    // When isBarrel is true, the AI skips fetching this file's content and
    // instead fetches the barrelTargets — the real implementation files.
    isBarrel: boolean;
    barrelTargets: string[];  // fileIds of the real implementation files

    // ── Semantic role ─────────────────────────────────────────────────────────
    //
    // Heuristically determined from file path, directory, and function kinds.
    // Used by the AI to prioritize files for a given issue type:
    //   e.g. auth issues → fetch files with role "auth" or "middleware"
    //   e.g. data issues → fetch files with role "repository" or "service"
    semanticRole: SemanticRole;

    // ── Reverse import graph ──────────────────────────────────────────────────
    //
    // importedBy: files that import THIS file — tells AI which files break
    //   if this one changes. Useful for impact analysis.
    // imports: files THIS file imports — tells AI what this file depends on.
    importedBy: string[];  // fileIds of files that import this file
    imports: string[];     // fileIds of files this file imports

    // ── Functions ─────────────────────────────────────────────────────────────
    functions: RetrievalFunction[];
}

// ── RetrievalIndex ────────────────────────────────────────────────────────────
//
// The top-level retrieval store. One per repository, keyed by (owner, repo).
// Built by buildRetrievalIndex() in parser/retrievalBuilder.ts after
// buildGraph() completes, and stored in Redis.
export interface RetrievalIndex {
    repoId: string;       // "owner/repo"
    commitSha: string;    // the commit this index was built from
    generatedAt: string;  // ISO timestamp
    files: RetrievalFileEntry[];
}
