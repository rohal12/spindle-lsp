# Closure review: 2026-10-06

**Assessment: materially converging, with five remaining demonstrated contracts.**
The original 61 retained checks all pass. Seven additional probes fail across
three existing contracts and two distinct regressions. These are added coverage,
not seven regressions in the historical corpus. No product changes, test skips,
assertion weakening, commits or pushes were made by this review.

## Scope and baseline

- Reviewed local `fix/review-convergence` at
  `e26552a2699030feb3b489cfceaf767f26a09dba`, initially clean.
- Comparison baseline: `11573c18a135cd15cd8372466619fd3ae882f64c`.
- Node 22.18.0; spindle-lsp 0.9.0; installed Spindle 0.45.1.
- This is a fix-closure audit plus bounded expansion of the existing ownership
  map, not an exhaustive Cartesian-product audit or a claim of no other bugs.
- HEAD is unpublished: GitHub's commit API did not resolve it. Issues #66–#81
  were still open. Local verification does not establish merged/published fixes.

Read `process.md`, the historical ledger, the retained corpus and current issue
bodies first. Applied rename edits with `TextDocument.applyEdits`; inspected the
installed runtime for expression/declaration semantics. Used only fixed benign
expressions. Compared relevant probes with extracted baseline source before
classifying introduction. The retained 0.51.3 tokenizer fixture has the same
SHA-256 as the freshly packed release's tokenizer:
`180203f6ae8c2be33b7ecb591074ea30f98e478dd04dc54120a40317618c168c`.

## Fresh verification

| Evidence | Result |
| --- | --- |
| `npm test`, installed 0.45.1 | Exit 0: 77 normal files / 1,977 tests, then 18 matrix files / 2,605 tests |
| `npm run typecheck`, installed 0.45.1 | Exit 0 |
| Historical case IDs compared with a fresh normal-suite JSON report | 61/61 present, unchanged IDs, all pass; original baseline was 10 pass / 51 fail |
| Matrix recorded states | 2,592 pass / 0 fail / 0 not-run / 13 not-applicable |
| `scripts/peer-matrix.sh 0.51.3 /tmp/spindle-peer-convergence-review` | Exit 0: 1,977/1,977 normal tests; typecheck exit 0 |
| Separate `npm run review:convergence` in the 0.51.3 scratch checkout | Exit 0: 18 files / 2,605 tests |
| New bounded probes below | Seven fail observations, five owning contracts |

The peer script runs the normal Vitest configuration and typecheck, not the
separate matrix configuration. Copied `docs/` into its scratch checkout before
running the matrix separately. Only 0.45.1 and 0.51.3 were freshly checked here;
the 22-release results in the earlier peer ledger were not rerun by this review.
Vitest counts not-applicable bookkeeping assertions as passing tests; the
recorded matrix states above distinguish those 13 cells.

## Extended contract corpus and ownership

| Stable probe ID | Owner | Classification | Observed failure |
| --- | --- | --- | --- |
| `F66/do-template-lf` | #66 | Existing baseline gap | Formatting changes a JavaScript template value |
| `R67/goto-arithmetic-name` | #67, coordinate #77 | Existing baseline gap | Rename emits an expression evaluating to `3`, rather than the passage `1 + 2` |
| `R67/include-inline-name-0.45.1` | #67 | Existing baseline gap | Renamed target `"inline"` evaluates to the empty string after runtime preprocessing |
| `P70/raw-do-js-link-string-0.51.3` | #70 | Remaining version-specific contract gap; introduction not established | A raw JS string becomes a passage reference and is renamed |
| `D/bom-first-header/raw-source-rename` | [#82](https://github.com/rohal12/spindle-lsp/issues/82) | Introduced corruption: baseline produced no edit | Applied LSP rename corrupts the first passage header |
| `C/variable-rename/digit-name` | [#83](https://github.com/rohal12/spindle-lsp/issues/83) | Introduced rejection | Valid runtime name `5` is rejected by the new JS-identifier guard |
| `C/variable-rename/internal-dollar` | Same variable-name grammar issue | Existing invalid acceptance | Accepted rename produces an invalid declaration |

Seven examples belong to five contracts. Do not split the two target-encoding
examples into symptom tickets, or merge variable-name grammar with #73's
repaired StoryInterface indexing simply because they share rename code.

### #66: preserve JavaScript values when formatting do bodies (P1)

```twee
:: StoryVariables
:: Start
{do}
const value = `a
b`;
{/do}
```

`formatDocument(text, {stringAwareBraces: true})` indents both JS lines:

```twee
{do}
  const value = `a
  b`;
{/do}
```

The fixed benign JS body returns `"a\nb"` before formatting and `"a\n  b"`
afterward. This also reproduces on the baseline. Both inspected runtime Do
components execute their body text. `src/plugins/format.ts:131` protects
multiline markup tokens, and line 192 then segments/indents the remaining body;
the JS template is not protected.

Closure: extend the formatting family with do-body JS templates, LF/CRLF and
inline/container controls; compare literal values without normalizing their
whitespace, and retain idempotence and unrelated-text checks. The generic
`runtimePayload` oracle ignores text tokens and whitespace-normalizes macro
arguments, so its green result cannot establish this preservation property.

### #67: encode the target for its actual runtime consumer (P2 residual)

```twee
:: Old
hi
:: StoryVariables
:: Start
{goto Old}
```

Rename `Old` to `1 + 2`. Applied output includes `:: 1 + 2` and
`{goto 1 + 2}`. Runtime evaluation computes `3`, so the navigation target is
`"3"`, not `"1 + 2"`. `src/plugins/rename.ts:186` uses
`resolveExpressionTarget()` as its round-trip guard, but the resolver at
`src/core/parsing/link-parser.ts:540` classifies this arithmetic as a bare name.

Replace the reference with `{include "Old"}` and rename to `inline`.
Output is `{include "inline"}`. **Spindle 0.45.1** removes the first word
`inline` before evaluating, including inside quotes, so it navigates to `""`.
This variant is pinned to that installed runtime; the freshly packed 0.51.3
Include component has different preprocessing and should have its own control.
Both rename failures also reproduce against baseline source.

Closure: add these two name choices to the passage-rename family, apply edits,
and validate the actual consumer's target value. Quote arithmetic appropriately;
for an unrepresentable consumer context, atomically reject instead of returning
a corrupt edit. Include quoted/bare controls and version-specific inline flag
handling. Coordinate static-target classification with #77. Production review
tooling must not evaluate arbitrary project expressions to find static names.

### #70: exclude modern raw do bodies from passage references (P2)

```twee
:: StoryData
{"format":"Spindle","format-version":"0.51.3"}
:: StoryVariables
:: Old
hi
:: Start
{do}
const note = "[[Old]]";
{/do}
```

A model without a project-installed version selects 0.51.3 from StoryData.
The pinned runtime emits macro/text/macro, with no link token. Nevertheless,
`findPassageReferences('Old', model, false)` returns the string's `Old` span
(line 7, characters 16–19), `computeDocumentLinks` returns a link, and renaming
the header rewrites the literal to `"[[New]]"`.

`src/core/parsing/link-parser.ts:488` masks non-markup passage roles but not raw
do bodies; `src/plugins/document-link.ts:46` parses their content similarly.
Closure: extend the context family with raw do-body link/macro-shaped strings;
check diagnostics, definition, references, prepare/rename, links and lenses
independently. Apply rename and verify the JS literal is unchanged. Pin modern
versions and retain older tokenizer behavior plus a real link outside do as
controls. Keep one owner (#70) for the affected consumers.

### #82: preserve raw source coordinates with BOM (P2)

Raw client text is `\uFEFF:: Old\nhi\n:: StoryVariables\n:: Start\n[[Old]]`.
Rename the first header at line 0, character 5 to `New`.

`src/core/workspace/document-store.ts:28` strips U+FEFF from the model while the
server retains the client's original TextDocument. Returned header range is
characters 3–6, but the original `Old` occupies characters 4–7. Applying the
actual returned edits gives `\uFEFF::Newd`, instead of `\uFEFF:: New`.
Also confirmed through framed JSON-RPC against a freshly built public stdio
executable. Baseline did not recognize this header and returned no edits; the
new corruption is a regression. This affects clients that send the BOM in text,
even if some editors strip it themselves.

Closure: add a raw-client boundary variant to `D/bom-first-header` and public LSP
entrypoint tests. Preserve the client coordinate basis or map positions both
ways. Apply edits to the original buffer, preserving BOM and the complete
header. Cover didOpen/didChange, unopened disk-loaded targets, first-line
prepareRename/definition/tokens, and non-BOM controls. Existing bounds checks
and oracle splitting both operate on BOM-stripped model text and miss this.

### #83: use Spindle's variable-name grammar (P2)

```twee
:: StoryVariables
$x = 1
:: Start
{$x}
```

At line 1, character 2, rename to `5` is rejected. The installed runtime's
`parseStoryVariables('$5 = 1')` accepts key `5`, and baseline rename produced
the valid declaration/reference pair. Conversely, rename to `a$b` is accepted
and produces `$a$b = 1` and `{$a$b}`; the runtime rejects that declaration.
The latter acceptance also existed at baseline.

`src/plugins/rename.ts:98` applies a JS-identifier regex allowing internal `$`
and excluding digit-leading identifiers. Spindle uses a word-character name
following the sigil. Closure: extend family C's rename-name choices; cover both
story/transient sigils, digit-leading/underscore controls, atomic rejection of
internal `$`, preserved property paths, and applied/rebuilt runtime-valid
declarations and usages. This is independent of #73's StoryInterface usage index.

## Next review and closure gate

1. Repair #66, #67 and #70 through their existing owners; use separate bounded
   owners for raw BOM coordinates and variable-name grammar.
2. Promote these seven observed probes and nearby controls into the relevant
   family tables/properties and transport tests alongside their fixes. No
   expected-failure assertions or skips; new cells must check desired behavior.
3. Preserve all 61 historical IDs and the existing matrix. Re-run the affected
   rows on their applicable runtime versions, then `npm test` and typecheck.
4. Record published fixing commits and evidence before closing GitHub tickets.
   Twelve other old owners have no remaining defect demonstrated in this bounded
   review; passing original cases alone is not a claim that every acceptance
   criterion or every possible consumer has been audited.
5. Compare the same historical corpus and these seven additions separately on
   the next pass. Expand again only when a failing contract reveals a nearby
   missing context or consumer. The remaining unrelated dimensions stay explicit
   coverage gaps rather than speculative tickets.

The process is working: historical failures fell from 51 to zero and the matrix
is mandatory. The next convergence step is to close these five bounded gaps and
strengthen the particular oracles that allowed them to survive, without
restarting an unbounded implementation scan after each repair.

GitHub follow-up evidence was added to
[#66](https://github.com/rohal12/spindle-lsp/issues/66#issuecomment-6005762388),
[#67](https://github.com/rohal12/spindle-lsp/issues/67#issuecomment-6005762784) and
[#70](https://github.com/rohal12/spindle-lsp/issues/70#issuecomment-6005763137).
Created #82 and #83 after extending the named contract corpus above, and updated
[#81](https://github.com/rohal12/spindle-lsp/issues/81) with the current checkpoint
while preserving the original audit as historical. No issues were closed.
