const test = require("node:test");
const assert = require("node:assert/strict");
const { decideParsing } = require("../dist/processing/parseDecider");

test("filters unsupported files and summarizes parse decisions", () => {
  const files = [
    { absolutePath: "/repo/src/main.ts", relativePath: "src/main.ts", sizeBytes: 1000 },
    { absolutePath: "/repo/src/types.d.ts", relativePath: "src/types.d.ts", sizeBytes: 1000 },
    { absolutePath: "/repo/src/huge.ts", relativePath: "src/huge.ts", sizeBytes: 3 * 1024 * 1024 },
    { absolutePath: "/repo/assets/logo.png", relativePath: "assets/logo.png", sizeBytes: 2500 },
    { absolutePath: "/repo/src/vendor.min.js", relativePath: "src/vendor.min.js", sizeBytes: 2500 },
  ];

  const originalLog = console.log;
  console.log = () => {};
  try {
    const summary = decideParsing(files);

    assert.equal(summary.stats.total, 5);
    assert.equal(summary.stats.filtered, 2);
    assert.equal(summary.stats.full, 1);
    assert.equal(summary.stats.importsOnly, 2);
    assert.equal(summary.stats.skipped, 0);

    const byPath = Object.fromEntries(summary.decisions.map((d) => [d.relativePath, d]));
    assert.equal(byPath["src/main.ts"].mode, "full");
    assert.equal(byPath["src/types.d.ts"].mode, "imports-only");
    assert.equal(byPath["src/huge.ts"].mode, "imports-only");
  } finally {
    console.log = originalLog;
  }
});

test("counts skip decisions when filtered file passes extension checks", () => {
  const files = [
    { absolutePath: "/repo/src/index.ts", relativePath: "src/index.ts", sizeBytes: 10 },
    { absolutePath: "/repo/src/runtime.chunk.ts", relativePath: "src/runtime.chunk.ts", sizeBytes: 1000 },
  ];

  const originalLog = console.log;
  console.log = () => {};
  try {
    const summary = decideParsing(files);
    assert.equal(summary.stats.filtered, 0);
    assert.equal(summary.stats.full, 1);
    assert.equal(summary.stats.skipped, 1);
    assert.equal(summary.decisions.find((d) => d.relativePath.endsWith(".chunk.ts")).mode, "skip");
  } finally {
    console.log = originalLog;
  }
});
