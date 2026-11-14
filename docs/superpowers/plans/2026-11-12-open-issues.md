# Open issue fixes implementation plan

**Goal:** Fix every actionable open issue in one pull request.
**Spec:** GitHub issues #274–#278 and AGENTS.md.
**Architecture:** Index adapter lookups without taking over Spindle's parsing rules. Preserve the originating diagnostic on quick fixes, consult the compiler for proposed destination roles, and iterate unbounded discovery batches.
**Tech stack:** TypeScript, Vitest, Spindle tooling, twee-ts, GitHub CLI.

## Constraints

- Initial enumeration found only #274–#278, no blocked issues and no open PRs.
- Base the branch on current origin/main; retain upstream-owned parsing and validation.
- Add regression coverage before each fix; keep existing assertions intact.
- Run tests, typecheck, build and all duplication tools against origin/main.
- Commit, push, and create one PR closing the fixed issues; inspect required CI/security results.

## Tasks

- [x] #274: Count diagnostic identity reads in a many-diagnostic request, including stale and moved inputs. Replace full-list searches with range/code buckets, retaining deep data equality.
- [x] #275: Exercise the registered LSP handler with same-code diagnostics at different locations and a bounded scale fixture. Carry originating diagnostics through internal actions and serialize only those, preserving client fields.
- [x] #276: Count token and widget-definition reads for repeated includes; cover nested labels/attributes, widget overrides and edits. Index include spans and widget names by source passage.
- [x] #277: Prove metadata creation actions are unusable and ordinary/special runtime names remain creatable. Ask the public compiler whether the actual proposed empty passage is emitted before offering it.
- [x] #278: Use public discovery above the argument-count limit for JS/TS, script and StoryInit sources, including last-definition precedence and edits. Iterate discovery batches.
- [x] Run complete local verification and review the branch. Publish the verified changes in one PR and inspect its required CI checks.

## Review focus

- Client diagnostic data remains untrusted; same-range stale data must not yield edits.
- LSP associations preserve the exact originating client's diagnostic, including optional fields.
- Include spans inside labels/attributes and replacement semantics remain correct.
- Reserved names with runtime roles retain creation fixes; metadata errors cannot be introduced by a destination fix.
- Large discovery batches retain source and runtime phase precedence.

## Progress

- Working in the existing checkout on a new branch, fix/open-issues-274-278, from origin/main (66af3b9). The user authorized branch creation, fixes, commits, push and PR.
- Reproduced #274 and #275 with failing operation-count/response-association tests. The indexed matching retains deep range/data equality; actions retain the originating client diagnostic, including optional fields. Focused tests pass.
- Reproduced #276's token scans and #277's three metadata actions with failing tests. Include lookups now use sorted tooling spans and a report-level source-passage widget index; the creation guard consults StoryBuilder and passageOmission for the actual proposed empty passage. Focused tests and prior widget-override regressions pass.
- Corrected three new control fixtures before implementation: absent StoryInit, StoryInterface and SaveTitle do not produce SP300 under the public API. StoryScript and StoryIncludes provide the applicable reserved-name creation controls.
- Reproduced #278's RangeError for JS, TS, script and StoryInit with 140,001 compiler-accepted discoveries. All three adapter aggregations now iterate in their original sequence; the regression checks final replacement metadata and refresh/removal.
- Typecheck and build pass. jscpd, PMD CPD and fallow comparisons against origin/main pass with zero added clones and zero added duplicated lines.
- Built stdio LSP probes: the 8,000-diagnostic request plus queued hover completed in 77 ms; the 16,000-include request plus queued hover completed in 30 ms. The 100-typo source returned 100 associations across 100 actions, serializing to 54,327 bytes (no filesystem config action with an untitled URI).
- Final suite: 2,899 tests in 120 files pass (18 added regressions). Type checking and build pass. The complete suite ran with TMPDIR=/var/tmp to avoid unrelated project files under /tmp.
- Final independent read-only review: no introduced regressions or actionable findings. No issues required upstream changes or blocked labels.
