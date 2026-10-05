# Peer-range verification — 2026-10-06

Follows [2026-10-06-convergence-fixes.md](2026-10-06-convergence-fixes.md), whose
known gaps listed the `@rohal12/spindle` peer range (`>=0.34.0`) as unverified.
Branch `fix/gap-i-peer`, Node 22.18.0. Control: 0.45.1 reproduces the baseline
(63 files / 1,402 tests, typecheck clean).

> Superseded by the [Result](#result--2026-10-06-branch-fixclose-o-version)
> section at the end: every open item below was closed there.

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

## Result — 2026-10-06 (branch `fix/close-o-version`)

Closes every item the sections above left open. Node 22.18.0. Method as above
(`scripts/peer-matrix.sh <version>`, run instructions in
[process.md](process.md)); this time every published release from 0.43.0 on was
run, not a sample.

### What changed

1. **The LSP knows the target Spindle.** `src/core/workspace/spindle-capabilities.ts`
   defines `SpindleCapabilities { version, source, supported, executableRefsOnly,
   primitiveMembers }`. `WorkspaceModel.capabilities` resolves, in order: the
   `@rohal12/spindle` installed under the workspace root (or an ancestor's
   `node_modules`, the lookup the builtin macro registry already uses; re-read on
   `refresh()`), then the `format-version` of a Spindle StoryData passage (live,
   on every cascade), then `DEFAULT_CAPABILITIES`: version unknown, the behavior
   the 0.45.1 tests pin (raw-text validation, no primitive members, supported).
   The LSP's own copy of Spindle is deliberately not consulted: it is a
   development or peer install and says nothing about the story's runtime.
2. **SP201 (and SP200) are version-gated.**
   - `executableRefsOnly` (>= 0.50.1): `src/core/parsing/executable-refs.ts` ports
     that release's markup tokenizer and `collectPassageRefs` with source offsets,
     so only executable references are validated (`{$v}`, expressions, macro
     arguments, `{do}` bodies, input-macro variable names, attribute
     interpolations); prose, plain strings and comments are not. SP200 uses the
     same reference list, so it follows the same rule (it had the same
     over-reporting; the runtime changed `validatePassages` for both).
     Below 0.50.1 the raw-text scan is kept unchanged.
   - `primitiveMembers` (>= 0.51.1): `findPrimitiveFieldAccess` walks a
     primitive's wrapper members as the runtime does (`part in Object(value)`,
     member `typeof` decides: number/string/boolean continue, anything else
     stops), so `$n.toFixed`, `$s.length` pass and `$s.length.x` is reported.
3. **SP001** (`UnsupportedSpindleVersion`, warning): when the detected version is
   below 0.43.0, the first story document carries a project-level warning
   (once, like SP202) and a StoryTransients passage gets an error (the old
   runtime rejects it). The server logs the detected target at startup and, below
   the floor, also logs a warning and sends `window/showMessage`. An undetectable
   version raises nothing.
4. **Peer range narrowed to `>=0.43.0`** in `package.json` and
   `package-lock.json`. Ledger decision: releases below 0.43.0 are demonstrably
   unsupported (no `%`/StoryTransients; before 0.38 also no attribute
   expressions, so SP103's model does not hold), as established above, and the
   LSP now says so (SP001) instead of silently accepting `%` syntax. The
   devDependency stays `^0.45.1`.
5. **Stale SP103 test fixed.** `needs {E ?? ''} for a dotted path` now expects
   `''` before 0.51.1 and `3` from it (`INSTALLED_CAPABILITIES.primitiveMembers`),
   and asserts that the `?? ''` form renders `3` on every version, which is what
   the quick fix relies on. The earlier note that the fix "yields the same text"
   was wrong for <0.51.1: it renders `3` instead of `''`, which is the intent.
6. **Whole-story SP201 test** no longer pins `toHaveLength(8)`: the expected
   runtime error count is 8 (<0.50.1), 4 (0.50.1-0.51.0), 3 (>=0.51.1), and the
   LSP-vs-runtime `toEqual` is asserted against whichever runtime is installed.

### Differential evidence

- `test/unit/executable-refs.test.ts`: `collectExecutableRefs` against a vendored
  copy of the 0.51.3 runtime (`test/fixtures/spindle-0.51.3`, Unlicense; its
  tokenizer and `collectPassageRefs` are byte-identical in 0.50.1-0.51.3), over
  75 hand-written fragments and 4,000 seeded random compositions (prose,
  strings, comments, `{do}`, selectors, HTML attributes incl. repeated names,
  input macros, links, escapes, unbalanced braces, non-ASCII), plus offset checks
  (`content.slice(offset)` is the `$ref`), plus SP201 under 0.51.3 capabilities
  against the vendored `validatePassages` over 9 defaults x 32 paths (including
  `constructor`, `__proto__`, `length.length`).
- The same file compares SP200 (undeclared names, with `{for}` locals) against
  the installed runtime on 1,500 random passages in whichever mode that version
  uses, so the 0.45.1 raw-text behavior is verified as well as the new one.
- `test/unit/spindle-capabilities.test.ts`: version thresholds, detection order,
  workspace-level behavior with fake installs (SP200/SP201 below/at 0.50.1 and
  0.51.1, ranges point at the source), SP001.
- The first fuzz run surfaced one oracle error, not an LSP one: the runtime
  skips `{for @a, @b of}` locals, which the comparison now mirrors.

### Matrix after the change

Every test file, `tsc --noEmit` clean on all rows. 65 files / 1,446 tests; no
skips. Passed/total:

| Spindle | passed | typecheck |
| --- | --- | --- |
| 0.43.0, 0.43.1, 0.43.2, 0.43.3, 0.43.4, 0.43.5, 0.43.6, 0.43.7 | 1446/1446 | clean |
| 0.44.0, 0.45.0, 0.45.1, 0.46.0, 0.47.0, 0.48.0, 0.49.0, 0.49.1, 0.50.0 | 1446/1446 | clean |
| 0.50.1, 0.51.0 | 1446/1446 | clean |
| 0.51.1, 0.51.2, 0.51.3 (latest) | 1446/1446 | clean |

All 22 published releases from 0.43.0 to 0.51.3 are covered; nothing in the
supported range is unrun. Below the floor, 0.42.0 run for the record: 1427/1446,
the 19 failures all being `%`/StoryTransients cases whose runtime oracle
throws (convergence-edits 6, declaration-runtime 2, diagnostics-contracts 8,
attribute-blocks-runtime 2, literal-contracts 1), the intentional version
difference that SP001 now reports. Releases 0.34.0-0.42.0 other than that one
were measured in the first run and are unsupported by decision (4 above).

Superseded earlier conclusions: "Not fixed in src/", "Conclusions and proposal
(not applied)" and the `<0.50.1` range alternative; the proposed follow-ups (a)
and (b) are implemented above rather than filed.

## Every release green — 2026-10-06 (branch `fix/close-q-versions`)

The previous section left 19 failures on the matrix copies of every release (12 on 0.43.0-0.50.0
too), recorded as "not new". They are fixed, so each published release from 0.43.0 on now passes
the whole suite. Node 22.18.0; `npm view @rohal12/spindle versions` lists exactly the 22
releases from 0.43.0 to 0.51.3 below (0.1.0-0.42.0 are older, unsupported by decision above).

### The 19 failures

| Count | Cause | Fix |
| --- | --- | --- |
| 12 | The dist-based tests (`bin`, `format-entrypoints`, CLI, MCP and LSP integration) build the executable with `npm run build` from the matrix copy, which `scripts/peer-matrix.sh` did not give `esbuild.config.ts` | The script copies `esbuild.config.ts`; no test change |
| 6 | `placeholders-oracle` (K66-scan) compared the formatter's token scan with the installed tokenizer; from 0.50.1 the tokenizer skips string and template literals when it counts braces (the file's `tokenizer.ts` is byte-identical in 0.43.0-0.50.0 and in 0.50.1-0.51.3, verified by hashing all 22 packs) | `SpindleCapabilities.stringAwareBraces` (>= 0.50.1); `scanSpindleTokens`/`replaceSpindleTokens`/`formatDocument` take the reading; the LSP, CLI and MCP tools resolve it from the target release; the oracle tests pass the installed release's reading and state both |
| 1 | `markup-differential` D3-fuzz excluded only some inputs on which the readings differ; an unbalanced `{` in an attribute value (0.50.1 ends the value at the next quote) was left out | The markup parser (`parseMacros`, `findBracketLinks`, `attributeValueSpans`, `scanHtmlTags` with a new `modern` policy, tracker, signature help) takes the same reading; the fuzz excludes nothing |

Making the reading exact exposed assertions that fixed the "unknown version" behavior
(`diagnostics-containers`, `diagnostics-malformed-element`, `diagnostics-attribute-blocks`,
`signature`, `macro-parser`, `macro-head-differential`); they now state both readings and compare
with `buildAST` for the installed release (details in
[2026-10-06-convergence-fixes.md](2026-10-06-convergence-fixes.md), "Link interpolation and brace
reading"). New: `test/unit/format-brace-reading.test.ts` (12), `test/unit/link-interpolation.test.ts`
(124), `test/helpers/runtime-ast.ts`; 77 files, 1,977 tests, no skips.

### Matrix

`scripts/peer-matrix.sh <version>` for every release, one run each, on the same sources
(branch tip). Passed / total and `tsc --noEmit` exit code:

| Spindle | passed | typecheck | | Spindle | passed | typecheck |
| --- | --- | --- | --- | --- | --- | --- |
| 0.43.0 | 1977/1977 | 0 | | 0.48.0 | 1977/1977 | 0 |
| 0.43.1 | 1977/1977 | 0 | | 0.49.0 | 1977/1977 | 0 |
| 0.43.2 | 1977/1977 | 0 | | 0.49.1 | 1977/1977 | 0 |
| 0.43.3 | 1977/1977 | 0 | | 0.50.0 | 1977/1977 | 0 |
| 0.43.4 | 1977/1977 | 0 | | 0.50.1 | 1977/1977 | 0 |
| 0.43.5 | 1977/1977 | 0 | | 0.51.0 | 1977/1977 | 0 |
| 0.43.6 | 1977/1977 | 0 | | 0.51.1 | 1977/1977 | 0 |
| 0.43.7 | 1977/1977 | 0 | | 0.51.2 | 1977/1977 | 0 |
| 0.44.0 | 1977/1977 | 0 | | 0.51.3 (latest) | 1977/1977 | 0 |
| 0.45.0 | 1977/1977 | 0 | | | | |
| 0.45.1 (devDependency) | 1977/1977 | 0 | | | | |
| 0.46.0 | 1977/1977 | 0 | | | | |
| 0.47.0 | 1977/1977 | 0 | | | | |

22 of 22 releases pass; `npm test` (0.45.1, the repository's own install) is 77 files / 1,977
tests, `npm run typecheck` exits 0. Both brace readings are exercised on both sides of the 0.50.1
boundary (0.50.0 and 0.50.1 are in the table), and the formatter, CLI and MCP entry points are
tested with fake installs of 0.50.0 and 0.50.1.
