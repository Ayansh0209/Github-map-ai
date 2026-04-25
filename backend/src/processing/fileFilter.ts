import path from "path";

const SKIP_FOLDERS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".output",
    "coverage",
    "__pycache__",
    ".cache",
    "vendor",
    "third_party",
    "extern",
    "generated",
    "auto_generated",
]);

const SKIP_EXTENSIONS = new Set([

    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp",
    ".mp4", ".mp3", ".wav", ".ogg", ".webm",
    ".pdf", ".zip", ".tar", ".gz", ".rar",
    ".ttf", ".woff", ".woff2", ".eot",
    ".exe", ".dll", ".so", ".dylib", ".bin",
    ".map",
    ".lock",
]);

const SKIP_FILENAME_PATTERNS = [
    ".min.js",
    ".min.ts",
    ".bundle.js",
    ".chunk.js",
    ".generated.ts",
    ".generated.js",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
];

// Phase 1: JS/TS only
// Phase 2: add .py .go .rs .cpp .c .java
const SUPPORTED_EXTENSIONS = new Set([
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".mjs",
    ".cjs",
]);

export function shouldProcessFile(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
    const segments = normalized.split("/");
    const filename = segments[segments.length - 1];
    const ext = path.extname(filename);

    // check every folder segment against skip list
    for (const segment of segments.slice(0, -1)) {
        if (SKIP_FOLDERS.has(segment)) return false;
    }

    // skip binary and irrelevant extensions
    if (SKIP_EXTENSIONS.has(ext)) return false;

    // skip generated file patterns
    for (const pattern of SKIP_FILENAME_PATTERNS) {
        if (filename.endsWith(pattern)) return false;
    }

    // only process supported code files
    return SUPPORTED_EXTENSIONS.has(ext);
}