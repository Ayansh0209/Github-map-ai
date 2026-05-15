const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldProcessFile } = require("../dist/processing/fileFilter");

test("should process supported source files", () => {
  assert.equal(shouldProcessFile("src/index.ts"), true);
  assert.equal(shouldProcessFile("src/component.tsx"), true);
  assert.equal(shouldProcessFile("src/utils/helpers.MJS"), true);
});

test("should skip files in ignored folders", () => {
  assert.equal(shouldProcessFile("node_modules/pkg/index.ts"), false);
  assert.equal(shouldProcessFile("src/generated/model.ts"), false);
  assert.equal(shouldProcessFile("frontend/.next/server/app.ts"), false);
});

test("should skip unsupported and binary files", () => {
  assert.equal(shouldProcessFile("assets/logo.png"), false);
  assert.equal(shouldProcessFile("src/data.json"), false);
  assert.equal(shouldProcessFile("src/index.d.ts"), true);
});

test("should skip known generated and lockfile patterns", () => {
  assert.equal(shouldProcessFile("src/vendor.min.js"), false);
  assert.equal(shouldProcessFile("src/runtime.bundle.js"), false);
  assert.equal(shouldProcessFile("src/module.generated.ts"), false);
  assert.equal(shouldProcessFile("package-lock.json"), false);
});

test("should normalize windows paths and mixed case", () => {
  assert.equal(shouldProcessFile("SRC\\UTILS\\HELPER.TS"), true);
  assert.equal(shouldProcessFile("SRC\\COVERAGE\\result.ts"), false);
});
