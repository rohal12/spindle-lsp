# Open issue fixes implementation plan

**Goal:** Fix all currently actionable GitHub issues and document remaining blockers.
**Spec:** GitHub issues #200, #202, #206, #208, #210 and #211, and AGENTS.md.
**Architecture:** Keep compiler and runtime semantics in their public APIs. Preserve metadata before formatting code; use public code pieces and write references to invalidate default-shape assumptions across the workspace.
**Tech stack:** TypeScript, Vitest, Spindle tooling/compiler/play, GitHub CLI.

## Constraints

- Do not copy upstream rules or weaken existing tests.
- Commit and push one branch; check for an existing PR and open one PR closing fixed issues.
- Recheck blocked issues, comment with evidence and blocking links.

## Tasks

1. Recheck blockers: #206 upstream spindle#680 remains open; #208 twee-ts#528 closed but latest published twee-ts remains 2.0.0 without that API; #200 fixture contract in #197 unchanged; #202 fixture contracts in #142/#181 unchanged. Retain blocked labels with current comments.
2. #210: Add a failing compiler-oracle regression for tagged StoryTitle/StoryData, then preserve compiler metadata before dispatching script/stylesheet formatting in src/plugins/format.ts. Keep ordinary code formatting. Exercise applied LSP edits, CLI and MCP.
3. #211: Add failing diagnostics/runtime regressions for story/transient root reassignment. Read parseCode(piece.code, piece.goal).refs write flags from workspace markup, retain writes per URI, suppress default-based member warnings for any possibly replaced root, and clear state on update/removal. Preserve unchanged-array and member-assignment controls. Check cross-file writes and executable nested code.
4. Run full tests with TMPDIR=/var/tmp, typecheck, all duplication checks against origin/main, build. Review the diff, commit, push, recheck existing PRs and open one PR closing #210 and #211.

## Review focus

- Tagged and escaped compiler metadata identities, LF/CRLF and ordinary code passages.
- Story and transient variables, cross-file reassignment and unsaved updates/removal.
- Public tooling determines executable code, including nested markup and custom macro context.
- Member assignments do not replace the root; ordinary reads retain existing warnings.
- No upstream semantic workaround or test weakening.

## Results

- Rechecked all six open issues; documented and retained the four unresolved blockers.
- Reproduced #210 and #211 with failing compiler/runtime-backed tests before fixing production code.
- Fixed both actionable issues with public runtime/compiler contracts and added editor, CLI and MCP coverage.
- Full suite: 2,715 tests in 113 files pass with TMPDIR=/var/tmp and two workers.
- Type checking and build pass. All three duplication tools pass; comparisons with origin/main add no duplicated lines or clones.
