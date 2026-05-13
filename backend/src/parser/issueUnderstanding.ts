// src/parser/issueUnderstanding.ts
// ─────────────────────────────────────────────────────────────────────────────
// Extracts structured search intent from raw issue text.
//
// This module is PURELY DETERMINISTIC — no AI calls, no external dependencies,
// no async operations. It takes raw text and returns a SearchIntent that the
// rest of the pipeline uses to navigate the retrieval graph.
//
// Why this exists:
//   The retrieval graph traversal needs to know WHAT the issue is about before
//   it can navigate to the right files. This module bridges raw human language
//   to structured signals the graph engine can use.
//
// The isVague flag:
//   When an issue yields insufficient signal (too few entities, generic language),
//   setting isVague=true routes the pipeline to an AI-first path where Gemini
//   reads the full issue text first to extract domain intent, rather than relying
//   on keyword extraction that would produce noise.
// ─────────────────────────────────────────────────────────────────────────────

// ── Output type ───────────────────────────────────────────────────────────────

export interface SearchIntent {
    /** Domain nouns extracted from the issue: "event", "agenda", "creator", "user" */
    entities: string[];

    /**
     * Action verbs extracted from the issue: "create", "update", "delete", "manage".
     * These map to database operations and resolver names.
     */
    operations: string[];

    /**
     * Technical concepts that activate specific retrieval signals:
     * "permission", "auth", "creator", "ownership", "role".
     * When concepts include auth-related terms, hasAuthCheck functions are
     * prioritised in snippet selection.
     */
    concepts: string[];

    /**
     * True when extraction yields insufficient signal for graph traversal.
     *
     * Vague issues are ones where:
     *   - The entity count is < MIN_ENTITIES threshold, AND
     *   - The full text reads as a generic complaint ("not working", "broken",
     *     "pretty functionality") without domain-specific nouns
     *
     * When isVague=true, the pipeline routes to an AI-first path:
     *   Gemini reads the issue → extracts domain → populates SearchIntent
     * rather than using this deterministic extraction alone.
     */
    isVague: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Words that provide no retrieval signal.
 * Covers common English stopwords + developer jargon that appears in every issue.
 */
const STOPWORDS = new Set([
    // Common English
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "must",
    "in", "on", "at", "to", "for", "with", "by", "from", "of", "into",
    "about", "between", "through", "after", "before", "above", "below",
    "and", "or", "but", "not", "no", "nor", "so", "yet",
    "this", "that", "these", "those", "it", "its",
    "i", "we", "you", "he", "she", "they", "me", "us", "him", "her", "them",
    "my", "our", "your", "his", "their",
    "what", "which", "who", "whom", "when", "where", "why", "how",
    "if", "then", "else", "than",
    "just", "also", "very", "too", "quite", "rather", "still", "already",
    // Issue/developer noise that appears in virtually every bug report
    "please", "help", "problem", "wrong", "broken", "working", "work",
    "issue", "bug", "fix", "error", "currently", "expected", "actual",
    "steps", "reproduce", "description", "version", "using", "see",
    "getting", "seems", "happens", "shows", "showing", "displayed",
    "screenshot", "following", "above", "behavior", "behaviour",
    "feature", "request", "functionality", "pretty", "nice", "good",
    "want", "need", "make", "click", "button", "page", "screen",
]);

/**
 * Technical concept keywords that activate specific retrieval signals.
 *
 * These are checked case-insensitively against the full issue text.
 * When matched, the snippet fetcher boosts functions with hasAuthCheck
 * or hasDatabaseCall signals.
 */
const AUTH_CONCEPTS = [
    "permission", "permissions", "auth", "authentication", "authorization",
    "role", "roles", "access", "owner", "ownership", "creator", "created by",
    "only", "allowed", "forbidden", "unauthorized", "restrict", "restricted",
    "private", "public", "visibility", "can only", "should only",
    "privilege", "privileges", "admin", "superuser", "moderator",
];

const DATA_CONCEPTS = [
    "save", "saved", "saving", "store", "stored", "persist", "persisted",
    "database", "db", "query", "fetch", "load", "retrieve", "read",
    "write", "insert", "update", "delete", "remove", "create", "add",
    "list", "search", "filter", "sort", "paginate", "pagination",
    "record", "records", "entry", "entries", "field", "fields",
];

/**
 * Operations vocabulary — verbs that appear in issue text and map to
 * code-level operations (CRUD, lifecycle actions, etc.)
 */
const OPERATION_KEYWORDS = new Set([
    "create", "creating", "created",
    "update", "updating", "updated", "edit", "editing", "edited",
    "delete", "deleting", "deleted", "remove", "removing", "removed",
    "add", "adding", "added",
    "fetch", "fetching", "fetched", "get", "getting", "load", "loading",
    "save", "saving", "saved", "store", "storing", "stored",
    "manage", "managing", "managed",
    "list", "listing", "listed",
    "search", "searching", "searched", "filter", "filtering",
    "view", "viewing", "viewed", "display", "displaying", "show", "showing",
    "send", "sending", "sent", "submit", "submitting", "submitted",
    "upload", "uploading", "download", "downloading",
    "assign", "assigning", "assigned",
    "invite", "inviting", "invited",
    "join", "joining", "joined", "leave", "leaving", "left",
    "cancel", "cancelling", "cancelled",
    "approve", "approving", "approved", "reject", "rejecting", "rejected",
    "publish", "publishing", "published", "draft",
    "import", "importing", "export", "exporting",
    "register", "registering", "login", "logout",
    "enable", "enabling", "disable", "disabling",
]);

/**
 * Minimum number of meaningful entities required for a "specific" issue.
 *
 * Reasoning: a useful graph traversal needs at least 2 domain-specific nouns
 * to narrow the candidate set. With only 1 entity (e.g. "button"), the search
 * space is too broad and we're better off letting Gemini read the full issue.
 */
const MIN_ENTITIES_FOR_SPECIFIC = 2;

/**
 * Minimum total signals (entities + operations + concepts) for a "specific" issue.
 *
 * Reasoning: if the total signal count is below this threshold, the issue
 * is either very short ("doesn't work") or too generic to produce useful
 * graph traversal. Route to AI-first path.
 */
const MIN_TOTAL_SIGNALS_FOR_SPECIFIC = 3;

// ── Tokenization ──────────────────────────────────────────────────────────────

/**
 * Tokenize raw text into normalized lowercase words.
 * Handles camelCase splitting, path separators, and common punctuation.
 */
function tokenize(text: string): string[] {
    const normalized = text
        // Split camelCase: "agendaItem" → "agenda Item"
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        // Replace non-alphanumeric (except apostrophes in contractions) with space
        .replace(/[^a-zA-Z0-9']/g, " ")
        // Collapse multiple spaces
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    return normalized.split(" ").filter(t => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Extract camelCase and PascalCase identifiers from code snippets in issue text.
 * Issues often include function names, variable names, or type names in backticks
 * or inline code blocks.
 */
function extractCodeIdentifiers(text: string): string[] {
    const identifiers: string[] = [];

    // Match backtick-quoted identifiers: `functionName`, `EventAgendaItem`
    const backtickMatches = text.matchAll(/`([a-zA-Z_$][a-zA-Z0-9_$]+)`/g);
    for (const match of backtickMatches) {
        const id = match[1];
        // Split camelCase/PascalCase into parts
        const parts = id
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .split(" ")
            .map(p => p.toLowerCase())
            .filter(p => p.length > 2 && !STOPWORDS.has(p));
        identifiers.push(...parts, id.toLowerCase());
    }

    // Match PascalCase/camelCase words in the text (likely type/function names)
    const camelMatches = text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]*)+|[a-z]+(?:[A-Z][a-z]*)+)\b/g);
    for (const match of camelMatches) {
        const id = match[1];
        const parts = id
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .split(" ")
            .map(p => p.toLowerCase())
            .filter(p => p.length > 2 && !STOPWORDS.has(p));
        identifiers.push(...parts);
    }

    return [...new Set(identifiers)];
}

// ── Concept detection ─────────────────────────────────────────────────────────

function detectAuthConcepts(fullText: string): string[] {
    const lower = fullText.toLowerCase();
    return AUTH_CONCEPTS.filter(c => lower.includes(c));
}

function detectDataConcepts(fullText: string): string[] {
    const lower = fullText.toLowerCase();
    return DATA_CONCEPTS.filter(c => lower.includes(c));
}

// ── Vagueness detection ───────────────────────────────────────────────────────

/**
 * Generic complaint phrases that appear in vague issues.
 * These match issues that describe a problem without domain context:
 *   "the pretty functionality is not working"
 *   "something is broken"
 *   "this doesn't work as expected"
 */
const VAGUE_PHRASES = [
    /\b(something|anything|everything|nothing)\s+(is|are|was|were|does|did)?\s*(not|n't)?\s*(work|working|broken|wrong|correct|right|showing|displayed)\b/i,
    /\b(doesn'?t|does not|isn'?t|is not)\s+work(ing)?\b/i,
    /\b(not working|not work|broken|doesn'?t work)\b/i,
    /\bpretty\b.*\bfunctionality\b/i,
    /\bsomething\s+is\s+(wrong|broken|off)\b/i,
    /\b(random|sometimes|occasionally|intermittently)\b/i,
];

/**
 * Determines if the extracted signal is insufficient for graph traversal.
 *
 * Logic:
 *   1. If the issue text matches known vague phrases → vague
 *   2. If entity count < MIN_ENTITIES and total signals < MIN_TOTAL → vague
 *   3. Otherwise → specific
 *
 * Note: we do NOT make vagueness binary based on length alone — a short issue
 * like "Event creators cannot delete their own events" is very specific despite
 * being short. Vagueness is about semantic density, not word count.
 */
function detectVagueness(
    fullText: string,
    entities: string[],
    operations: string[],
    concepts: string[],
): boolean {
    // Pattern-based vagueness check — high confidence
    if (VAGUE_PHRASES.some(p => p.test(fullText))) {
        return true;
    }

    // Signal density check
    const totalSignals = entities.length + operations.length + concepts.length;
    if (entities.length < MIN_ENTITIES_FOR_SPECIFIC && totalSignals < MIN_TOTAL_SIGNALS_FOR_SPECIFIC) {
        return true;
    }

    return false;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract structured search intent from raw issue text.
 *
 * Combines the issue title, body, and up to 5 comments into a single text
 * block for analysis. Comments are included because developers often describe
 * the root cause in comments, not in the original issue body.
 *
 * @param title    Issue title
 * @param body     Issue body (markdown)
 * @param comments Array of comment bodies (pass [] if not available)
 * @returns SearchIntent with entities, operations, concepts, and isVague flag
 */
export function extractSearchIntent(
    title: string,
    body: string,
    comments: string[] = [],
): SearchIntent {
    // Combine all text — title gets double weight by including it twice
    // since titles are the most concise description of the issue
    const fullText = [title, title, body, ...comments.slice(0, 5)].join(" ");

    // ── Step 1: Tokenize and extract base entities ────────────────────────────
    const tokens = tokenize(fullText);
    const codeIdentifiers = extractCodeIdentifiers(fullText);

    // Deduplicate: merge tokens and code identifiers
    const allTokens = [...new Set([...tokens, ...codeIdentifiers])];

    // ── Step 2: Separate operations from entities ─────────────────────────────
    const operations: string[] = [];
    const entities: string[] = [];

    for (const token of allTokens) {
        if (OPERATION_KEYWORDS.has(token)) {
            operations.push(token);
        } else {
            entities.push(token);
        }
    }

    // ── Step 3: Detect technical concepts ────────────────────────────────────
    const authConcepts = detectAuthConcepts(fullText);
    const dataConcepts = detectDataConcepts(fullText);
    const concepts = [...new Set([...authConcepts, ...dataConcepts])];

    // ── Step 4: Determine vagueness ───────────────────────────────────────────
    const isVague = detectVagueness(fullText, entities, operations, concepts);

    // ── Step 5: Cap sizes to avoid token explosion ────────────────────────────
    // Reasoning: more than 20 entities produces a search space too wide to
    // be useful. Cap at 20 to keep the retrieval focused.
    const finalEntities  = [...new Set(entities)].slice(0, 20);
    const finalOps       = [...new Set(operations)].slice(0, 10);
    const finalConcepts  = [...new Set(concepts)].slice(0, 15);

    return {
        entities:   finalEntities,
        operations: finalOps,
        concepts:   finalConcepts,
        isVague,
    };
}

/**
 * Check if a SearchIntent contains auth-related concepts.
 * Used by the snippet fetcher to boost hasAuthCheck functions.
 */
export function intentHasAuthSignal(intent: SearchIntent): boolean {
    const authTerms = new Set([
        "permission", "permissions", "auth", "authentication", "authorization",
        "role", "roles", "owner", "ownership", "creator", "access",
        "forbidden", "unauthorized", "restrict", "restricted", "privilege",
    ]);
    return intent.concepts.some(c => authTerms.has(c));
}

/**
 * Check if a SearchIntent contains data-operation concepts.
 * Used by the snippet fetcher to boost hasDatabaseCall functions.
 */
export function intentHasDataSignal(intent: SearchIntent): boolean {
    const dataOps = new Set([
        "save", "store", "persist", "database", "query", "fetch",
        "create", "update", "delete", "insert", "load", "retrieve",
        "add", "remove", "list", "search", "filter",
    ]);
    return (
        intent.operations.some(op => dataOps.has(op)) ||
        intent.concepts.some(c => dataOps.has(c))
    );
}
