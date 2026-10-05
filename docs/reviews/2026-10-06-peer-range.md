# Peer-range verification — 2026-10-06

Follows [2026-10-06-convergence-fixes.md](2026-10-06-convergence-fixes.md), whose
known gaps listed the `@rohal12/spindle` peer range (`>=0.34.0`) as unverified.
Branch `fix/gap-i-peer`, Node 22.18.0. Control: 0.45.1 reproduces the baseline
(63 files / 1,402 tests, typecheck clean).

## Method

`scripts/peer-matrix.sh <version> [scratch]` copies `src/`, `test/` and the
configs to a scratch directory whose `node_modules` is a real directory of
symlinks to the repo's, except `@rohal12/spindle`, which is the packed release
of that version. The tests' relative `node_modules/@rohal12/spindle/src/...`
imports therefore hit the version under test, and the repo's `node_modules` is
never modified. The full normal suite and `tsc --noEmit` run per version.

Run: 0.34.0, 0.35.0, 0.36.2, 0.37.1, 0.38.0, 0.38.1, 0.39.1, 0.40.1, 0.41.0,
0.42.0, 0.43.0, 0.43.7, 0.44.0, 0.45.0, 0.45.1, 0.46.0, 0.47.0, 0.48.0, 0.49.1,
0.50.0, 0.50.1, 0.51.0, 0.51.1, 0.51.2, 0.51.3 (latest). Not run: other patch
releases (0.36.0/.1, 0.37.0, 0.39.0, 0.40.0, 0.43.1-.6, 0.49.0, 0.50.x
between). Bisected boundaries are exact only to the versions listed.

## Matrix (tests grouped by contract file)

Columns are the five test files that contain every failure: SP103 =
`attribute-blocks-runtime`, #69 = `convergence-edits`, SP204/207 =
`declaration-runtime`, #72 = `diagnostics-contracts`, SP201 =
`field-access-runtime`. "other" is the remaining 58 files (all pass everywhere).
Counts are failing tests. Typecheck passes on every version.

| Spindle | SP103 | #69 | SP204/207 | #72 | SP201 | other | passed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.34.0 - 0.38.0 | fail (3) | fail (6) | fail (2) | fail (3) | pass | pass | 1388/1402 |
| 0.38.1 - 0.42.0 | fail (2) | fail (6) | fail (2) | fail (3) | pass | pass | 1389/1402 |
| 0.43.0 - 0.50.0 | pass | pass | pass | pass | pass | pass | 1402/1402 |
| 0.50.1, 0.51.0 | pass | pass | pass | pass | fail (1) | pass | 1401/1402 |
| 0.51.1 - 0.51.3 | fail (1) | pass | pass | pass | fail (2) | pass | 1399/1402 |

Individual versions listed above all fall in the row shown; 0.38.0 behaves like
0.34-0.37, 0.38.1 like 0.39-0.42.

## Classification of failures

No failure is a test-harness import-path break: every `src/...` module the
tests import exists in 0.34.0 through 0.51.3.

### 0.34.0 - 0.42.0: `%` transient sigil and StoryTransients (intentional version difference; LSP unsupported)

Spindle 0.43.0 introduces transients (`%name`, `StoryTransients`). Before it,
`parseStoryVariables` rejects `%x = 1` ("Invalid declaration ... Expected:
$name = value"). Failing: #69 Q69-`%`-* (6), #72 X72-StoryTransients* (3),
SP204/207 (2), SP103 `{print}` quick fix with `{%t * 2}` (1; 0.38.1+).
These tests feed `%` syntax to the old runtime oracle, so the failures show
the runtime lacks the feature. Product consequence (not a test artifact): on
<0.43 the LSP still accepts `%` declarations, `{%t}` and StoryTransients
passages without a diagnostic, although the runtime would throw at startup.
That is a missing "unsupported by installed Spindle" diagnostic, not a
regression of any fixed contract.

### 0.34.0 - 0.37.1: attribute `{expression}` blocks (intentional version difference)

Before 0.38.0, `interpolate` only resolves `{$a.b}` simple references; full
expressions in HTML attributes are not evaluated. SP103 (which flags blocks
Spindle does not evaluate) therefore disagrees with that runtime on
`{$n > 0 ? 'pos' : 'neg'}`; its quick fixes are also built for the 0.38+
evaluator. Same classification: the LSP's SP103 model assumes >=0.38.

### 0.50.1 and later: SP201 over-reports (product defect for that version range)

0.50.1 rewrote `validatePassages` to scan only executable references
(tokenizer-based: `{$v}`, expressions, macro arguments, `{do}` bodies,
input-macro variable names, attribute interpolations). Prose, plain strings and
comments are no longer scanned. The LSP's SP201 still reports field accesses
in prose/strings/comments (the 0.45.1 behavior the process doc says to
preserve). Probe on the whole-story fixture: runtime reports 4 errors (0.50.1)
or 3 (0.51.x), SP201 reports 8, e.g. `Hello $name.first`, `<!-- $on.x -->`,
`$name.length` in prose, `\$on.escaped`. These are false-positive errors on
valid stories. The failing assertion is the pinned count (`toHaveLength(8)`),
which hides that the LSP-vs-runtime `toEqual` has not been evaluated; this
probe, not the assertion text, establishes the over-reporting.

### 0.51.0/0.51.1 and later: primitive members (product defect for that version range)

From 0.51.1 the runtime lets a primitive's wrapper members validate
(`$n.toFixed`, `$s.length`, ...). SP201 still reports "Cannot access field" for
them (false positive; test `reports no field error Spindle does not`). In
0.51.0 only the whole-story check fails. The SP103 test
`needs {E ?? ''} for a dotted path` pins 0.45.1's `''` rendering for
`{$s.length}` in an attribute; 0.51.1+ renders `3`. The `?? ''` quick fix stays
harmless (it yields the same text), so this is a stale oracle, not a defect.

## Not fixed in src/, and why

Both real defects (SP201 on >=0.50.1, and the missing unsupported-feature
diagnostics on <0.43) require the LSP to know the installed Spindle version
and gate behavior on it. There is no version plumbing today (the workspace
only locates `macro-registry.json`). Adding it is a feature, not a small
compatibility patch, and ungated changes would break the 0.45.1 contract the
tests pin. Left as proposals below.

## Conclusions and proposal (not applied)

- Verified supported: **0.43.0 - 0.50.0** (full suite and typecheck green).
  Verified with known SP201/SP103 false positives: 0.50.1 - 0.51.3.
- 0.34.0 - 0.42.0 lack transients and, before 0.38, attribute expressions;
  the contract corpus does not hold there. Treat as unsupported.
- Proposed peer range: `>=0.43.0` (hard floor, evidence above). If SP201
  false positives are unacceptable before a gated fix, use `>=0.43.0 <0.50.1`
  instead. Verified-green 0.43.0-0.50.0 spans 0.43.1-0.43.6 and 0.49.0, which
  were not run individually.
- Follow-up, per the one-owner rule, one issue each: (a) SP201 should follow
  the installed runtime's reference scan and primitive-member rules, gated by
  installed version, keeping the 0.45.1 behavior below 0.50.1; (b) diagnostics
  for `%`/StoryTransients/attribute expressions when the installed Spindle is
  too old, if the floor is not raised.
- `package.json` `devDependencies` stays `^0.45.1`; CI only exercises that
  version. Running `scripts/peer-matrix.sh` over the boundary versions (0.43.0,
  0.50.0, latest) before a release would keep this evidence current.
