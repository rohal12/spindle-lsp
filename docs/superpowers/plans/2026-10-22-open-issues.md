# Open GitHub Issues Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. The user authorized implementation, commits, push, and one pull request.

**Goal:** Fix all five open issues (#73, #107, #145, #146, #152).

**Architecture:** Consume released Spindle tooling for widget selection and executable reference roles. Keep file selection in the shared discovery layer so CLI, MCP, and LSP scans share the symlink policy. Preserve the existing uncommitted fixes and verify their regressions against the base revision.

**Tech Stack:** TypeScript, Node 24+, Vitest, Spindle 0.62.0, twee-ts 2.

**Spec:** AGENTS.md and GitHub issues https://github.com/rohal12/spindle-lsp/issues/73, /107, /145, /146, /152 (including their linked reproductions).

## Global Constraints

- Parsing and runtime rules come exclusively from public `@rohal12/spindle/tooling`.
- Do not skip, invert, or weaken assertions to make checks green.
- Run `npm test`, `npm run typecheck`, duplication checks against the base, and `npm run smoke:pack`.
- One PR closes fixed issues; no merge or release is authorized.

## Review Focus

- Literal glob prefixes and linked directory selections must not traverse links; explicitly selected files retain opt-in behavior.
- Disappearing enumeration results must not discard valid neighboring files.
- Widget selection must preserve document identity even with duplicate passage names, incomplete definitions, and CRLF.
- Loop reads must distinguish destructuring targets from defaults, computed keys, member assignments, and template interpolations.
- Applied rename must preserve actual runtime output, with updated unsaved indices and genuine script exclusions.

### Task 1: Upgrade released dependencies (#145)

**Files:** package.json, package-lock.json, .github/workflows/ci.yml, docs/mcp-play-tools.md.
**Interfaces:** Provides public `effectiveWidgetDefinitions(WidgetDefinition[])` and `parseCode(code, goal).refs` with read/write roles to Tasks 4 and 5.

- [x] Verify old peer metadata cannot accept twee-ts 2; verify the released 0.62.0 package accepts it and exports both APIs.
- [x] Upgrade Spindle to 0.62.0 and twee-ts to ^2.0.0 with a normal npm install; set Node >=24 and CI Node 24.
- [x] Run typecheck and existing tests; fix compatibility defects in src. Expected: no compile/type regressions.
- [x] Run packaging smoke during final validation. Expected: a clean installed MCP story plays successfully.

### Task 2: Restore executable StoryScript usages (#73)

**Files:** src/core/workspace/variable-tracker.ts, test/unit/variable-tracker.test.ts, test/unit/navigation-contracts.test.ts.
**Interfaces:** Uses PassageMarkup's existing executable pieces; produces normal usages for all markup passages.

- [x] Run the existing new StoryScript regressions against base source. Expected: missing executable usages/rename failure.
- [x] Verify removing only the passage-name exclusion fixes it while `[script]` and bare prose remain excluded.
- [x] Run both suites. Expected: cross-file $/% property renames, LF/CRLF, rebuilt indices, usage counts, and actual compiled/play output pass.

### Task 3: Exclude symlinks from automatic discovery (#152)

**Files:** src/core/workspace/macro-sources.ts, src/core/workspace/file-inputs.ts, test/integration/audit-issue-152.test.ts, test/unit/file-discovery-races.test.ts, docs/mcp-play-tools.md.
**Interfaces:** `findProjectFiles(root, pattern)` and `resolveFiles(pattern, cwd)` retain string[] outputs and literal-file opt-in.

- [x] Run regression tests against base source. Expected: automatic formatting changes an external sentinel and linked directories are enumerated.
- [x] Verify shared enumeration excludes linked file/directory paths including literal prefixes, while explicit file links work.
- [x] Verify missing/replaced enumeration ancestors retain neighboring files and skip broken links.
- [x] Run both suites. Expected: CLI/MCP scans leave external files untouched, regular files still format, no linked directory is enumerated.

### Task 4: Consume effective widget definitions (#146)

**Files:** src/core/workspace/widget-registry.ts, src/plugins/diagnostics.ts, test/unit/audit-issue-146.test.ts.
**Interfaces:** Consumes Task 1 selection API, maps definition object identity to PassageMarkup before selection; registry provides one effective WidgetDef per name to all consumers.

- [x] Add both source/ingestion permutations and LF/CRLF reproductions. Assert selected URI/ranges, parameter holds, block status/arity diagnostics, and definition/signature help.
- [x] Add incomplete and duplicate-passage-name controls plus unsaved override edits. Expected: selected closed widget keeps the correct source identity.
- [x] Run before fixing. Expected: tagged override wins incorrectly and literal rename changes runtime output.
- [x] Select through public effectiveWidgetDefinitions and use the same effective registry metadata for diagnostic lookups, retaining all definitions for declaration-only diagnostics.
- [x] Run regression suite and widget/navigation neighbors. Expected: applied/rebuilt rename preserves actual play output and effective widget metadata everywhere.

### Task 5: Consume executable read/write roles (#107)

**Files:** src/plugins/diagnostics.ts, test/unit/diagnostics.test.ts (SP205 family), test/integration/cli.test.ts if consumer coverage needs extension.
**Interfaces:** Consumes Task 1 `parseCode` refs; maps code-piece offsets with `pieceOffset`.

- [x] Add write-only array/object/nested/rest destructuring cases and positive default/computed-key/member/compound/template reads; retain literal/prose and deferred/accumulator controls.
- [x] Run before fixing. Expected: write-only cases emit false SP205.
- [x] Replace the read suffix heuristic with public parsed read roles. Malformed code must not produce speculative read warnings.
- [x] Run SP205 and CLI/MCP diagnostics checks. Expected: only real executable reads trigger SP205 with correct ranges.

### Final verification and publication

- [x] Run complete tests, typecheck, build, packaging smoke, all three duplication tools against dcbed80, and git diff --check.
- [x] Review the complete diff for introduced regressions; fix material findings and rerun affected checks.
- [ ] Update issues with results, retaining blocked only if a new external dependency prevents a fix.
- [ ] Commit, push branch, recheck existing PRs, and create/update one PR closing all fixed issues.

## Execution decisions

- Continue on the existing task branch, preserving its uncommitted StoryScript and symlink repairs. A separate base snapshot verifies the regressions without discarding those changes.
- Pin Spindle 0.62.0 exactly. It supplies both required public tooling APIs and accepts twee-ts 2. Version 0.62.1 intentionally changes declaration syntax (upstream spindle#617); adopting it would require inverting three retained declaration assertions. Keep the current grammar contract and align the bundled tooling with the installed play runtime.
- Retain incomplete widget declarations for editor lookup and read their parameters through public tooling for local completions. Only effective closed definitions feed runtime argument roles and diagnostic lookups.
- twee-ts 2 requires story titles. Add titles to the timeout and serialization test fixtures without changing their assertions. Known runtime fixtures explicitly pass the new public `trusted: true` option; the MCP host authorization gate remains covered.
- Base-source verification: 22 regressions fail across the StoryScript/symlink suites; the working fixes pass all 107 targeted cases. Widget precedence and write-only destructuring also fail before their consumer fixes. The focused widget/loop/navigation run passes 168 tests.

## Final verification

- `TMPDIR=/var/tmp/spindle-lsp-issues-20261022 npm test -- --maxWorkers=2`: 2,274 tests in 93 files pass.
- `npm run typecheck`, `npm run build`, `SMOKE_PACK_DIR=/var/tmp/spindle-lsp-issues-20261022 npm run smoke:pack`: pass.
- All three duplication tools pass against dcbed80: unchanged duplicated line counts (jscpd 215, CPD 334, fallow 930).
- `claude plugin validate .`: passes with the existing optional-version warning; this plugin intentionally follows the latest npm release.
- `git diff --check`: passes. Whole-change independent review identified the incomplete-widget completion regression; the repair uses public declarations and the unchanged completion assertions now pass. The final compatibility delta was also reviewed locally after interruption.
