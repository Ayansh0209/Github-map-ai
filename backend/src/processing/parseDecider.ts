import { FileEntry } from "../github/downlaod";
import { shouldProcessFile } from "./fileFilter";
import { getParseMode, ParseDecision } from "./sizeHandler";

export interface DecisionSummary {
    decisions: ParseDecision[];
    stats: {
        total: number;
        full: number;
        importsOnly: number;
        skipped: number;
        filtered: number;
    };
}

export function decideParsing(files: FileEntry[]): DecisionSummary {
    const decisions: ParseDecision[] = [];
    let filtered = 0;

    for (const file of files) {
        // first check if we should process this file at all
        if (!shouldProcessFile(file.relativePath)) {
            filtered++;
            continue;
        }

        // then decide how deeply to parse it
        const decision = getParseMode(
            file.absolutePath,
            file.relativePath,
            file.sizeBytes
        );

        decisions.push(decision);
    }

    // log summary so you can see what is happening
    const full = decisions.filter((d) => d.mode === "full").length;
    const importsOnly = decisions.filter((d) => d.mode === "imports-only").length;
    const skipped = decisions.filter((d) => d.mode === "skip").length;

    console.log(`[parseDecider] total: ${files.length} files`);
    console.log(`[parseDecider] filtered out: ${filtered} (not code files)`);
    console.log(`[parseDecider] full parse: ${full}`);
    console.log(`[parseDecider] imports only: ${importsOnly}`);
    console.log(`[parseDecider] skipped: ${skipped}`);

    return {
        decisions,
        stats: {
            total: files.length,
            full,
            importsOnly,
            skipped,
            filtered,
        },
    };
}