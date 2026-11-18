# Open issue fixes implementation plan

> Execute inline with systematic debugging and test-driven development; review the whole branch before publishing.

**Goal:** Fix open GitHub issues #287–#293 in one pull request.
**Architecture:** Keep Spindle's public tooling authoritative. Change only source-coordinate mapping, aggregation, destination lookup, and formatting in the LSP adapters.
**Tech stack:** TypeScript, Vitest, Node 24.
**Spec:** GitHub issue bodies #287–#293 and AGENTS.md.

## Constraints and review focus

- No parsing-rule workarounds or dependency changes.
- Preserve source order, escaped UTF-16 coordinates, effective replacement roles, both variable namespaces, and line endings.
- Use operation counts for scan regressions, rather than elapsed-time thresholds.
- Check builtin dialog bodies beginning with quotes and replacement dialog parameters in nested markup.
- Keep all existing assertions; run the full suite, typecheck, and three duplication detectors against origin/main.

## Tasks

1. Reproduce #288, #292, #293 with small controls and flat 140,000-item fixtures. Assert every macro head/reference and independent structural errors survive. Replace function-call spreads with iteration; run focused tests.
2. Reproduce #291 with 0/1/3/10,000 BOM prefixes and LF/CRLF/CR. Preserve the complete prefix while formatting once; compare compiler passage identities and idempotence.
3. Reproduce #287 by counting numeric reads of public sourceOffsets in escaped labels. Reuse indexed boundary lookup with exact-boundary checks; assert source ranges before and after edits.
4. Reproduce #290 by counting passage enumeration on warm diagnostics. Build one effective destination map per check and share it with widget diagnostics; verify replacements and actual SP302 warnings.
5. Reproduce #289 with widget/discovered dialog replacements, top-level and nested calls. Classify builtin body references using effective public metadata; verify applied rename and prepareRename ranges, and retain builtin text semantics.
6. Run all checks, review the branch, commit fixes, push, check for an existing PR, and open one PR closing the seven issues.

Each implementation task starts with failing regression tests and ends with passing focused tests. GitHub has no open blocked issues to re-check. All seven defects are in this repository's adapter code.

## Verification

- All seven original failures reproduced before their fixes; new controls preserve existing behavior.
- Full suite: 2,916 tests passed across 124 files (`TMPDIR=/var/tmp npm test -- --maxWorkers=2`).
- `npm run typecheck` and `npm run build` passed.
- `npm run duplication` and all three `--base origin/main` comparisons passed: jscpd 1.68%, CPD 2.52%, fallow 6.71%; no added duplicated lines or clones.
- Independent read-only review: no introduced regressions or blocking requirement gaps.
- No issues required a blocked label or an upstream change.
