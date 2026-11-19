# Open GitHub issues implementation plan

**Goal:** Fix all four open issues (#200, #295–#297) in one pull request.
**Architecture:** Keep compiler and Spindle tooling as the authority. Correct source selection and source indexing in the adapter, and guard file ingestion before reads.
**Spec:** GitHub issues 200, 295, 296, 297 and repository AGENTS.md.
**Execution:** Independent fixes in parallel, followed by combined verification and a fresh review. The user has authorized implementation, commits, push and one PR.

## Constraints and review focus

- Do not implement compiler or runtime rules locally or weaken existing tests.
- Preserve effective declaration, metadata and entry selection after live edits.
- Preserve decoded label/code ownership, nested spans and document offset mapping.
- Preserve directory traversal and explicit symlink policy; check the current file type at ingestion.
- Add no source duplication; run full tests, typechecking and all duplication scanners.

## Tasks

- [x] #200: Add failing compiler-oracle tests in `test/unit/issue-200.test.ts` and integration coverage for superseded StoryData errors, same and separate files, valid replacements and live repairs. Change `src/plugins/diagnostics.ts` to validate all source StoryData declarations while retaining effective metadata for entry checks. Run targeted tests.
- [x] #295: Add failing quick-fix tests for both sigils, separate documents, effective replacement/removal, and non-colliding controls. Change `src/plugins/code-actions.ts` to consult the existing effective declaration index for conflicts. Run targeted tests.
- [x] #296: Add operation-count regressions for rename and inlay hints and mapping/innermost-owner controls. Cache a source-owner index per immutable passage in `src/core/markup/source-view.ts` using the tooling-owned pieces. Run targeted tests.
- [x] #297: Add bounded child-process FIFO tests for automatic story/macro discovery, explicit sources and watcher ingestion. Guard discovery and ingestion with shared regular-file handling, preserving directories and symlinks. Run targeted tests.
- [x] Run `npm test`, `npm run typecheck`, build, all three duplication scanners compared with origin/main; run packaging smoke if relevant shared play paths changed.
- [x] Review the complete diff with a fresh reviewer; no actionable introduced regressions found.
- [ ] Commit, push branch, check for an existing matching PR and open one PR closing the fixed issues.

## Issue triage

GitHub lists exactly #200, #295, #296 and #297 open, with no blocked issues. The prior maintainer decision for #200 is recorded in its comments and resolved; no upstream blocker is currently identified. Only an unrelated Dependabot PR is open.

## Verification

- Full suite: `TMPDIR=/var/tmp/spindle-lsp-issues-tests npm test -- --maxWorkers=8`: 2,964 tests passed in 128 files.
- `npm run typecheck` and `npm run build`: passed.
- `npm run duplication` and all three comparisons with `origin/main`: passed; duplicated lines and clone counts unchanged. Percentages: jscpd 1.66%, CPD 2.49%, fallow 6.64%.
- `SMOKE_PACK_DIR=/var/tmp/spindle-lsp-issues-smoke npm run smoke:pack`: passed, installed MCP play reached Start.
- Independent review checked compiler replacement semantics, ownership index containment and regular-file read lifecycle; no actionable findings.
