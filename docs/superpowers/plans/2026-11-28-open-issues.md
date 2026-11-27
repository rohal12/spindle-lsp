# Open issues #324–#326 implementation plan

**Goal:** Resolve every actionable open issue in one pull request and link external blockers.
**Architecture:** Keep Spindle responsible for parsing and decoding. Index the LSP's existing masked-code advisory scans and share indexed effective passage membership across configured checks.
**Tech stack:** TypeScript, Vitest, public Spindle tooling.
**Spec:** GitHub #324, #325, #326 and AGENTS.md.

## Constraints and review focus

Preserve accumulator exclusion, nested-expression delimiter depths, malformed-code diagnostics, source ranges, effective passage replacements and compiler omissions. No new parser or duplication. #325 requires upstream decoded passage-name boundary maps absent in Spindle 0.64.31; file/link its blocker instead of implementing string decoding here.

### Task 1: Link external blocker (#325)

- [x] Verify the public API gap and duplicate-check upstream issues.
- [x] File the missing public passage-name source-map capability upstream, comment on #325 with the link and reason, and apply `blocked`.

### Task 2: Index configured passage membership (#326)

- [x] Add operation-count regression in `test/unit/diagnostics-enumeration.test.ts`, including known/missing names, edits, duplicate replacement and compiler omissions.
- [x] Confirm failure from per-reference linear membership work.
- [x] Change `StateInfo.passages` to indexed readonly membership and build/share it lazily per story report in `src/plugins/diagnostics.ts`; preserve empty-collection behavior.
- [x] Run parameter-validator and diagnostics-enumeration tests; expect pass.

### Task 3: Bound assignment RHS analysis (#324)

- [x] Add operation-count coverage for same-expression assignments and semantic controls for nested delimiters, self-reference, separate statements, and source coordinates.
- [x] Confirm repeated suffix work exceeds the bound.
- [x] Index masked-code delimiter depths and temporary occurrences once per set argument; query RHS boundaries and accumulator membership without repeated suffix copies/scans.
- [x] Run the new tests and existing SP205 regressions; expect pass.

### Final verification and delivery

- [x] Run full npm test, typecheck, build, all three duplication checks against origin/main.
- [x] Review the complete diff and resolve substantive findings.
- [ ] Recheck open issues and PRs, commit, push the fix branch and create one PR closing the fixed issues. Inspect required checks.

## Execution record

- Working from clean `origin/main` 70125c2 on `fix/open-issues-324-326` in the authorized checkout. User authorized implementation and delivery; execute continuously.

- #325: public API gap reproduced; upstream blocker https://github.com/rohal12/spindle/issues/793 filed, linked in a comment on #325, and `blocked` applied. No local decoder introduced.
- #326: RED operation counts were 4,160 / 16,512 searched entries for 64 / 128 references. Shared indexed membership passes all 113 validator/enumeration tests, including edits and replacements.
- #324: RED suffix input was 724,732 / 2,891,260 characters for 256 / 512 assignments. Indexed implementation passes the new regressions and existing SP205 controls. Original 16,000-assignment reproduction now completes in 407 ms with SP106/SP205 retained; warmed 24,000 configured references take 342 ms with no diagnostics (local probe).
- Independent read-only review: no introduced regressions; 200,000 generated masked-code comparisons matched the old scanner. The reviewer deferred judgement of #325 because it is explicitly blocked on the public API. No unrelated behavior was changed.
- Build, typecheck, and jscpd/CPD/fallow comparisons against origin/main pass; clone counts do not increase. Full suite passes: 3,069 tests in 134 files (108.87 seconds); all 129 focused tests pass as well.
