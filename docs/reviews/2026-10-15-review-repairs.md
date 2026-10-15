# Repairing the fourteen open review tickets

The starting tree was clean at `bd1f350` (Node 22.18.0, spindle-lsp 0.9.0,
bundled Spindle 0.59.31). Open issue bodies were preserved before triage.
`TMPDIR=/var/tmp npm test` passed 1,958 unit/integration tests in 79 files
and 5,825 matrix cells in 18 shards; typecheck passed. `/var/tmp` avoids an
unrelated `/tmp/.git` project marker. These are existing defects, not findings
of introduction by a particular commit.

During the repair, main advanced to `f7cf152` (PR #92). The branch incorporated
that tree and its Spindle 0.60.0 `formatPassage` migration. Superseded local
formatter changes were removed; no local formatter fallback is retained.

## Ownership and retained contracts

| Ticket | Disposition and evidence |
| --- | --- |
| #18 | Already fixed by tooling migration. `DECLARATION-LOCATION` reapplies declaration/usage renames for both sigils and checks real reference and workspace-symbol locations, including null defaults. |
| #27 | Already fixed. `MACRO-DISCOVERY/StoryInit-edit` verifies discovery, diagnostics, and stale-definition removal after edits. |
| #37 | Already fixed under the current runtime contract. `PASSAGE-LITERALS` covers single quotes and include flags; the existing matrix retains CSS prefixes, navigation and applied rename. Bare names are expressions, not literal references. |
| #66 | Already fixed. The retained `DO_LITERALS` table executes the reported if/while/for regex contexts over seven wrappers and LF/CRLF, preserving exact values and idempotence. |
| #83 | Already fixed. The rename table retains valid `$5`, rejects internal `$`, and checks applied property-path preservation. Digit-leading transients remain rejected because the runtime reads `%5` as modulo in code. |
| #93 | Repair: atomically reject existing variable names in either declared namespace and case-insensitive widget collisions; preserve no-op and unused destinations. `RENAME-COLLISION` covers declaration/usage initiation, cross-document widgets and public LSP rejection. |
| #94 | Repair: use tooling source spans and the shared passage encoder for SP300/SP113; encode every enclosing label and reread the replacement with `passagePieces` before offering it. `QUICKFIX-PASSAGE` applies both quote styles and bare quoting across labels, nested labels, attributes, LF/CRLF; public LSP applies the offered edit. |
| #95 | Fixed by the `formatPassage` migration in PR #92. `FORMAT-MARKER` preserves original SP/SVG marker text, payload order/count and idempotence, including attributes, restored payloads and CRLF. No removed placeholder implementation is reintroduced. |
| #96 | Upstream owner: [rohal12/spindle#560](https://github.com/rohal12/spindle/issues/560). Spindle 0.60.0, 0.60.1 and 0.60.2 still abort on narrow-width wrapping; the public formatter now owns the repair. `FORMAT-WRAP` retains 21 bounded CLI cases, including tabs and nested list/macro wrappers. Six are genuine failures until the fixed upstream release is bundled; they are neither skipped nor treated as expected. |
| #97 | Repair: outline widgets come from the tooling-backed registry. `OUTLINE-WIDGET` checks comments, literal strings, multiline/CRLF, StoryInit, incomplete declarations and escaped selection spans. Public LSP checks the outline. |
| #98 | Repair: non-identifier keys use bracket access, replacing the dot and typed prefix/tail and encoding enclosing labels. `COMPLETION-FIELD` applies both sigils across documents, labels and attributes and evaluates only fixed benign fixtures with the public runtime transform. |
| #99 | Repair: null entries normalize to empty metadata; invalid entry/field shapes reject the complete configuration before replacing the usable registry. Initial invalid LSP config logs a controlled error and retains builtins; CLI reports a controlled error, MCP reports and recovers, watched reload preserves the prior config. `CONFIG-ENTRY` retains each consumer. |
| #100 | Repair: actual directories become the glob's working directory, exact files remain exact paths, and glob input remains supported. `MCP-PATH` exercises all three tools over stdio, empty directories, trailing slashes and directories containing glob characters. |
| #101 | Repair: `splitArgs` owns boundaries; diagnostics and signature selection share static classification without evaluating project expressions. `CONFIGURED-ARGS` retains grouped/array/object/template expressions, digit-leading variables, literal numbers and genuine literal type errors with a discovered runtime macro. |

The normal unit/integration and review gates share the behavior tables in
`test/review/support/repair-contracts.ts` and `repair-entrypoints.ts`. They add
252 independently recorded cells without removing or changing the states of
the existing 5,825 cells (including the 13 existing not-applicable cells).
An initial 144-cell subset reproduced 82 failures against `bd1f350` in an
isolated worktree; all 144 passed after the local repairs, before PR #92 moved
formatter ownership upstream. Additional label cases exposed and repaired a
completion-encoding gap; nearby identifier-key controls still pass.

## Verification

The upstream repair is committed as `bc75a44` in
[rohal12/spindle#561](https://github.com/rohal12/spindle/pull/561). Its 21 bounded
cases reproduce six aborts before the repair and all pass afterwards. The
upstream build, typecheck, Prettier check, 4,507 tests in 255 files, duplication
checks and all GitHub CI checks pass. Node 22 CI initially timed out in the
unchanged deterministic formatter fuzz test; the targeted coverage run and the
failed-job rerun passed without changing its assertions or timeout.

An isolated LSP checkout with the built upstream candidate passes all 2,089
unit/integration tests in 80 files and all 6,077 matrix cells in 18 shards
(6,064 applicable passes and the 13 retained not-applicable cells). This is
candidate validation, not a claim about a published release. The primary
checkout still bundles published Spindle 0.60.0: `TMPDIR=/var/tmp npm test`
exits 1 with 2,083 passes and the six #96 abort cases. The matrix independently
retains the same six genuine failures. No assertion is skipped or weakened.

`npm run typecheck` exits 0. `npm run duplication` and each tool's comparison
against `f7cf152` exit 0 with the existing budgets:

| Tool | Base | Repair | Duplicated lines, base → repair |
| --- | --- | --- | --- |
| jscpd | 2.53% | 2.49% | 265 → 254 |
| PMD CPD | 4.12% | 4.02% | 433 → 412 |
| fallow | 10.70% | 10.50% | 1,113 → 1,064 |

The LSP PR remains a draft until upstream #561 is merged/released, the pinned
devDependency and lockfile consume that published release, and the normal
checks pass on it. Merge/release approval is pending because the original task
authorized commits, pushes and PRs, not an upstream merge that publishes npm.
The six failures remain defects with that owner; the draft is not ready to
merge. Once the dependency is released, regenerate the results file and record
the published runtime and green commands here before closing #96.

## Published release and merge verification — 2026-10-15

The draft dependency gate above is resolved. Upstream PR #561 merged as
`2efcd0a45b6610b5fe9adfc67bff089b1bec6314`; its automatic
[release workflow](https://github.com/rohal12/spindle/actions/runs/38648107197)
passed and published Spindle 0.60.3. The LSP now pins that published release
in its devDependency and lockfile. The lockfile's root peer range is also
synchronized with the existing `package.json` range, `>=0.60.0`.

On Node 22.18.0, `TMPDIR=/var/tmp npm test` exits 0: all 2,089 unit/integration
tests in 80 files and all 6,077 matrix cells in 18 shards pass. Regenerating
the retained results against 0.60.3 changes exactly the six #96 wrapping
cells from fail to pass; all cell identities, dimensions and the 13 retained
not-applicable states are unchanged. No assertion was removed or weakened.
`npm run typecheck`, `npm run build` and `npm run duplication` also exit 0;
duplication remains 2.49% jscpd, 4.02% PMD CPD and 10.50% fallow.

The actual PR diff and relevant consumers received a second independent
review with no actionable findings, including the dependency provenance and
the six result transitions. An additional 48 temporary edit-encoding probes
passed for nested labels and quoted/backslash passage names; the permanent
ticket-owned contracts remain in the normal gate. This supersedes the draft
publication blocker recorded above; #96 is repaired by the bundled release.
