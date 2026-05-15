const test = require("node:test");
const assert = require("node:assert/strict");
const { getParseMode } = require("../dist/processing/sizeHandler");

const KB = 1024;
const MB = 1024 * 1024;

test("returns skip for minified and bundled filenames", () => {
  const minified = getParseMode("/tmp/a.js", "src/app.min.js", 100);
  const bundled = getParseMode("/tmp/a.js", "src/chunk.bundle.ts", 100);

  assert.equal(minified.mode, "skip");
  assert.equal(minified.skipReason, "minified/bundled file");
  assert.equal(bundled.mode, "skip");
});

test("returns imports-only for declaration files", () => {
  const result = getParseMode("/tmp/types.d.ts", "src/types.d.ts", 100);
  assert.equal(result.mode, "imports-only");
  assert.equal(result.skipReason, "type definition file (imports only)");
});

test("returns full parse for files smaller than threshold", () => {
  const result = getParseMode("/tmp/main.ts", "src/main.ts", 499 * KB);
  assert.equal(result.mode, "full");
  assert.equal(result.skipReason, undefined);
});

test("returns imports-only for medium size files without explicit reason", () => {
  const result = getParseMode("/tmp/medium.ts", "src/medium.ts", 500 * KB);
  assert.equal(result.mode, "imports-only");
  assert.equal(result.skipReason, undefined);
});

test("returns imports-only with reason for very large files", () => {
  const result = getParseMode("/tmp/huge.ts", "src/huge.ts", 3 * MB);
  assert.equal(result.mode, "imports-only");
  assert.equal(result.skipReason, "large file - imports only for performance");
});
