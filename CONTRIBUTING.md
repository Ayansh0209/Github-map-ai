# Contributing to CodeMap AI

Short version: this is a deterministic codebase mapping tool for open source newcomers, with optional AI on top for explanation and issue analysis.

## Run it locally

Follow the setup steps in the root README.md. If something is unclear, open an issue and we will improve the docs.

1. TypeScript stays in strict mode.
2. Do not change graph schema field names without a migration plan.

## Parser changes need extra care

The parser is the most sensitive part of the project. If you change anything in backend/src/parser, test it on at least three different repos before opening a PR.

## Big changes

If you are planning a large refactor or a new feature, open an issue first so we can align and avoid duplicate work.
