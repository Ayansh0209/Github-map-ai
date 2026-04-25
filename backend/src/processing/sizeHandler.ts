import path from "path";

export type ParseMode = "full" | "imports-only" | "skip";

export interface ParseDecision {
    absolutePath: string;
    relativePath: string;
    sizeBytes: number;
    mode: ParseMode;
    skipReason?: string;
}

const KB = 1024;
const MB = 1024 * KB;

export function getParseMode(
    absolutePath: string,
    relativePath: string,
    sizeBytes: number
): ParseDecision {
    const filename = path.basename(relativePath).toLowerCase();

    // skip minified / bundled files
    if (
        filename.includes(".min.") ||
        filename.includes(".bundle.") ||
        filename.includes(".chunk.")
    ) {
        return {
            absolutePath,
            relativePath,
            sizeBytes,
            mode: "skip",
            skipReason: "minified/bundled file",
        };
    }

    // type definition files
    if (filename.endsWith(".d.ts")) {
        return {
            absolutePath,
            relativePath,
            sizeBytes,
            mode: "imports-only",
            skipReason: "type definition file (imports only)",
        };
    }

    // small files → full parse
    if (sizeBytes < 500 * KB) {
        return {
            absolutePath,
            relativePath,
            sizeBytes,
            mode: "full",
        };
    }

    // everything else → imports only
    return {
        absolutePath,
        relativePath,
        sizeBytes,
        mode: "imports-only",
        skipReason:
            sizeBytes > 2 * MB
                ? "large file - imports only for performance"
                : undefined,
    };
}