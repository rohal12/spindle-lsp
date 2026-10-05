# Review process for convergence

The goal is to make each repair close a bounded behavior contract across its
consumers, and retain the evidence for future sessions. A fresh list of isolated
examples is insufficient. This process applies to implementation audits, defect
triage, and verification of fixes; ordinary small changes need only the relevant
rows. It does not require a complete parser rewrite.

## Start from a reproducible baseline

1. Read `AGENTS.md`, the requested scope, open issues, and the latest review
   ledger. Record HEAD, working-tree changes, Node, LSP and installed Spindle
   versions. Preserve an issue-body snapshot before restructuring tickets.
2. For a diff review, resolve the comparison base and inspect the actual diff.
   Report introduced regressions separately from existing implementation gaps.
   For a full audit, state that introduction has not been established unless
   history demonstrates it. `git blame` gives line provenance, not proof of a
   bug's introduction.
3. Run normal tests and typecheck. Record their exact counts and exit codes.
   Existing green tests establish the baseline; they do not establish coverage
   of the proposed contract.
4. Reproduce the existing backlog before looking for additional defects.
   Disposition each case as confirmed, fixed, unsupported by this version,
   intentional/documented, duplicate, or unverified. Do not call an assertion
   failure a product bug until fixture validity and harness correctness are checked.

## Select a contract and its consumers

Map each defect to the smallest shared behavior, not just the file containing
the observed symptom. For example, passage reference extraction has diagnostic,
definition, references, rename, document-link and code-lens consumers. An edit
is correct only when applying it leaves valid source with the intended meaning.

Build a matrix before expanding the review. Use these dimensions where relevant:

| Dimension | Representative cases |
| --- | --- |
| Passage role | ordinary markup, widgets, StoryInit, StoryInterface, declarations, StoryData, script and stylesheet |
| Source context | macro head/argument, bracket target/label, variable/property path, quoted string/template, HTML attribute, comment, prose |
| Spelling | CSS selectors, hyphenated widget names, sigils, escaped header names, quoted/bare/static/dynamic targets |
| Boundary | complete/incomplete input, multiline input, EOF with/without newline, empty passage, LF/CRLF, UTF-16 cursor offsets |
| State | multiple files, unsaved edit, add/remove/close document, config opened first, project format/version |
| Consumer | diagnostics, definition, references, prepare/rename, completion, signature help, semantic tokens, links/lenses, formatting, CLI/LSP entrypoint |

Do not claim an exhaustive Cartesian product. Select and name the cells affected
by the contract and include both a failing case and a nearby valid control.
Maintain explicit **pass / fail / not run / not applicable** states. Coverage of
one consumer does not imply coverage of the others. A test that stops at its
first assertion does not demonstrate its later assertions on that baseline.

## Validate meaning, not just response shape

Use the installed runtime as the oracle for the supported version. Tokenize a
small fixture, parse its declaration, or inspect the exact runtime call path.
Record normalization done by the compiler, such as CRLF to LF. Upstream main is
additional evidence, not a replacement for the installed dependency. A syntax
case accepted by another runtime version is not automatically a defect here.
The current audit covers Spindle 0.45.1 (the devDependency, and the behavior
used when no version can be detected). The supported range is `>=0.43.0`; the
suite is green on every release from 0.43.0 to 0.51.3
([2026-10-06-peer-range.md](2026-10-06-peer-range.md)).

### Running the suite against another Spindle

```
scripts/peer-matrix.sh <spindle-version> [scratch-dir]
# e.g. for v in 0.43.0 0.50.0 0.50.1 0.51.1 0.51.3; do scripts/peer-matrix.sh $v; done
```

The script packs that release, copies `src/`, `test/` and the configs to
`<scratch>/run/<version>` (default `$TMPDIR/spindle-peer`), links the repo's
`node_modules` except `@rohal12/spindle`, runs vitest and `tsc --noEmit`
there (including `esbuild.config.ts`, which the dist-based tests build the
executable with) and prints `<version> <passed>/<total> tsc=<exit>`;
`out.json`, `out.log` and `tsc.log` stay in the run directory. The repo's `node_modules`
is never modified. Tests find the runtime by relative
`node_modules/@rohal12/spindle/src/...` imports and learn its version from
`test/helpers/spindle-version.ts`, so version-dependent expectations follow
the installed release. Run the boundary releases (0.43.0, 0.50.0, 0.50.1,
0.51.0, 0.51.1) and the latest before changing version-gated behavior or the
peer range; a skipped test counts as not run, so the suite has none.

Version-dependent behavior lives in
`src/core/workspace/spindle-capabilities.ts` (`SpindleCapabilities`): the
target version is the one installed under the workspace root, else StoryData's
`format-version`, else the Spindle 0.45.1 behavior. Add a flag there, with the
release that introduced the behavior, rather than testing versions inline.
Code that reads braces the way the tokenizer does takes a `BraceReading`
(`stringAwareBraces`, from 0.50.1) and its callers pass
`workspace.capabilities`; an omitted reading means the 0.45.1 behavior. Oracle
tests compare against the installed tokenizer with the matching reading
(`INSTALLED_CAPABILITIES`) instead of excluding the inputs on which releases
differ, and state both readings with a StoryData `format-version` when a test
must fix the release.

Different runtime consumers have different contracts:

- Markup tokens determine which macro/link syntax executes.
- Interpolation is per consumer, not per syntax: the `{link}` macro (every
  bracket link) interpolates its `.class#id` selectors but prints its label and
  navigates to its target as written; `{button}` and `{dialog}` interpolate
  their label; HTML attribute values are interpolated; a string in any other
  macro's arguments is not. Render the markup with a real release
  (`scripts/runtime-render.mjs`) before encoding a rule about it.
- Executable symbol usages drive navigation and rename.
- Spindle's startup variable validation can inspect raw passage text, including
  strings/prose that are not executable references. Preserve that behavior in
  diagnostics; do not reuse an executable-only reference list for it.
- `goto`/`include` evaluate expressions, while the installed `link` macro
  extracts quoted text with its own rules. Encoding must follow each consumer.

For transformations, apply all edits with `TextDocument.applyEdits`, across all
affected documents. Rebuild the workspace, reparse the resulting story, and
verify the intended symbol/literal values and preservation of unrelated text.
For formatting, compare meaningful runtime payloads before/after and check
idempotence; do not equate arbitrary prose whitespace with semantic invariance.
For completion, apply `textEdit` or the actual cursor insertion, rather than
checking that a label exists. For signature help, verify parameter meaning and
that the active index describes the argument being typed. For semantic tokens,
check range validity and negotiated overlap behavior.

Use fixed benign fixtures when evaluating expressions in tests. Review tooling
must not evaluate arbitrary user/project expressions to discover static names.
For process behavior, exercise the bundled public executable with real framed
JSON-RPC; direct handler tests do not prove command dispatch or transport.

## Keep one owner per defect

Each issue needs:

1. A bounded contract and user-visible consequence, with priority.
2. A minimal valid reproduction, pinned source/runtime evidence, and an honest
   baseline or introduction classification.
3. Stable case IDs and independently testable acceptance criteria covering the
   affected consumers, variants, and positive controls.
4. Related issues, prerequisites where real, and a closure gate.

Extend an existing issue when a new example violates the same contract and can
be repaired and verified together. Do not create a ticket for every feature
affected by one bad reference span. Keep distinct behavior contracts separate
even if they share a helper; this avoids a large issue that closes after only
one symptom is fixed. Consolidate actual duplicates only after transferring
their reproductions and tests; cross-link them and identify duplicate closure,
never imply they were fixed.

Track workstreams in a parent checklist. Prioritize data corruption first.
Agree on shared context/literal representations before parallel changes to
their consumers; the representation must retain source spans and enough
context to produce correct edits. A consistent set of smaller helpers can
satisfy this requirement without a new universal AST.

## Retain and measure the corpus

The executable corpus is `test/review/convergence.review.ts`, with its separate
`vitest.review.config.ts`. Run:

```sh
npm test
npm run typecheck
npm run review:convergence
npm run review:convergence -- --reporter=json --outputFile=/tmp/spindle-review.json
```

The backlog command intentionally returns nonzero while desired behavior fails.
It is not part of `npm test` yet. Do not invert assertions, add expected-failure
markers, delete cases, or skip them to shrink the failure count. When a contract
passes, move its checks into the normal suite, preserving IDs and issue mapping,
or enable the full audit in CI once all contracts pass. Do not leave a repaired
contract indefinitely outside the normal gate.

After each fix, run its entire contract row, neighboring contexts, and relevant
closed-issue controls; then run normal checks. Broaden the matrix when new
evidence exposes another affected consumer/context. Record added cases
separately from changes in status of existing cases so increased coverage is
not mistaken for a regression.

Measure unresolved contracts and failures on the same corpus, plus new cases,
reopened contracts and remaining untested cells. Raw ticket counts and passing
test totals are poor measures of convergence. The dated ledger is historical:
add a new dated result instead of silently changing the old baseline.

## Closure and review completion

Close a defect only when its reproduction and required variants pass, controls
remain green, affected edits are applied and validated, and tests enter the
normal gate. Record the fixing commit/PR, runtime version and verification.
One failing consumer keeps that contract open. A broader review completes when
its selected matrix has dispositions, every confirmed failure has an owner,
evidence is retained, and remaining coverage gaps are explicit. This is a
bounded completion criterion, not a claim that no other defects exist.

The initial ledger is [2026-10-05-convergence.md](2026-10-05-convergence.md).
