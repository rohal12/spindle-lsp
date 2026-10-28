# Open issue fixes implementation plan

**Goal:** Fix all actionable open GitHub issues in one pull request.
**Spec:** Issues #232, #233, #234 and AGENTS.md.
**Architecture:** Consume public Spindle contextual invocations where available. Share runtime passage names lazily within a diagnostic pass instead of enumerating the workspace per passage. Track missing public tooling spans and unfinished ownership upstream.
**Tech stack:** TypeScript, Vitest, Spindle tooling/compiler/play, GitHub CLI.

## Constraints

- Initial check: all three open issues were unblocked and no PR was open.
- No duplicate parsing rules, upstream workarounds, or weakened assertions.
- Work on `fix/issues-232-234`, based on current `origin/main`.
- Commit, push and open one PR closing the issues fixed here.

## Tasks

- [x] #232: Reproduced escaped completion suffixes and checked public APIs in Spindle 0.64.8/0.64.9. Full general identifier spans and mappings through unfinished labels are missing. Removed the partial implementation, filed spindle#706, commented and labelled this issue blocked.
- [x] #233: Added failing bounded-enumeration regressions, then shared lazy passage names within a diagnostic pass. Configured validation stays current after edits and replacement/omission changes.
- [x] #234: Added failing regressions and corrected complete-clause hover, signatures and hints with contextual invocations. Genuine nested/label/attribute calls and replacement controls retain help; actual LSP responses are covered. Unfinished clauses still lack public ownership information: filed spindle#707, commented and labelled this issue blocked. Retained the complete-clause corrections as partial progress; this PR must not close #234.
- [x] Run full tests, typecheck, build, and all duplication tools against `origin/main`. Review the complete diff. Publish one branch/PR closing #233 and referencing the partial #234 correction, then inspect required CI/security results.

## Review focus

- Escaped root/member suffixes map through decoded labels and CRLF correctly.
- Incomplete expressions and macro calls retain completion/signature support.
- Replacement macros change whether an option is a clause or invocation.
- Passage validation reflects edits and runtime omission without a stale cache.
- Enumeration assertions count real operations rather than relying on timing.

## Progress

- GitHub enumeration found only #232, #233 and #234; no blocked issues or open PRs. Prior PR #231 is merged and its source tree matches the fresh baseline.
- Fresh review found the two upstream API gaps above and no introduced regression in the retained #233/#234 changes. Ruling: do not infer identifier/ownership grammar locally; retain only corrections directly supported by the current API. Cost: #232 and unfinished #234 remain unresolved until upstream exposes the needed information.
- Scale probe: a valid 118,923-byte, 8,002-passage story returned no diagnostics; first check 718 ms, cached check 10 ms, one effective-passage enumeration on the cached pass. Timing is local evidence; regression assertions count operations.
- Final local validation: 2,765 tests in 116 files pass; type checking and build pass. jscpd, PMD CPD and fallow pass their budgets and comparisons with `origin/main`, with no additional duplicated lines or clones. The existing test assertions were not weakened or skipped.
