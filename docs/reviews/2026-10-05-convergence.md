# Convergence audit — 2026-10-05

Scope: full implementation/backlog audit, followed by targeted expansion of
passage-reference consumers. Product behavior was not changed. Existing issues
#66–#80 remain distinct closure contracts; no real bug is closed merely to
reduce the ticket count.

The review began on October 5; ticket restructuring completed on October 6
(Asia/Singapore). The dated filename retains the review's starting date.

Baseline: `11573c18a135cd15cd8372466619fd3ae882f64c`, spindle-lsp 0.9.0,
Node 22.18.0, installed Spindle 0.45.1. The audit adds local review instructions,
documentation, a test corpus, config and npm command. These artifacts are not
committed/pushed as part of this session. Parent tracker:
[#81](https://github.com/rohal12/spindle-lsp/issues/81).

## Baseline results and ownership

The first completed corpus has **61 checks: 10 pass, 51 fail, 0 skipped**.
These are scenarios/consumer checks for **15 already filed defects**, not 51
new issues. All 15 contracts remain reproducible. Fresh normal verification:
`npm test` passes **57 files / 1,250 tests** (exit 0), and `npm run typecheck`
passes (exit 0). The backlog audit returns exit 1 for its 51 desired-behavior
failures. Machine-readable case statuses are retained in
[2026-10-05-convergence-results.json](2026-10-05-convergence-results.json).

| Issue | Case prefix | Contract | Pass / fail |
| --- | --- | --- | --- |
| [#66](https://github.com/rohal12/spindle-lsp/issues/66) | F66, C-F66 | Preserve multiline macro payloads through HTML formatting, LF/CRLF | 1 / 2 |
| [#67](https://github.com/rohal12/spindle-lsp/issues/67) | R67, C-R67 | Contextual rename: double/single/backtick literals and backslashes | 1 / 4 |
| [#68](https://github.com/rohal12/spindle-lsp/issues/68) | Q68 | Creation quickfix edits story documents when config opens first | 0 / 1 |
| [#69](https://github.com/rohal12/spindle-lsp/issues/69) | Q69 | Applied declaration fixes: both sigils, EOF value/header/newline | 2 / 4 |
| [#70](https://github.com/rohal12/spindle-lsp/issues/70) | X70, C-X70 | Literal/code contexts across six passage-reference consumers | 3 / 22 |
| [#71](https://github.com/rohal12/spindle-lsp/issues/71) | X71 | Bracket-link labels do not create macro container errors | 0 / 1 |
| [#72](https://github.com/rohal12/spindle-lsp/issues/72) | X72, C-X72 | Data/declaration passage strings receive no markup errors | 1 / 3 |
| [#73](https://github.com/rohal12/spindle-lsp/issues/73) | V73 | Cross-file StoryInterface executable variable references/rename | 0 / 1 |
| [#74](https://github.com/rohal12/spindle-lsp/issues/74) | W74 | CSS-prefixed and hyphenated widget navigation/rename | 0 / 2 |
| [#75](https://github.com/rohal12/spindle-lsp/issues/75) | E75 | Completion inserts a valid closing macro at the real cursor | 0 / 1 |
| [#76](https://github.com/rohal12/spindle-lsp/issues/76) | B76, C-B76 | Bundled no-argument and explicit-stdio initialize handshake | 1 / 1 |
| [#77](https://github.com/rohal12/spindle-lsp/issues/77) | L77 | Decode Unicode/hex escapes in goto/include static targets | 0 / 4 |
| [#78](https://github.com/rohal12/spindle-lsp/issues/78) | D78, C-D78 | Required StoryVariables with/without empty declaration passage | 1 / 1 |
| [#79](https://github.com/rohal12/spindle-lsp/issues/79) | H79 | Builtin parameter-schema expansion and partial-token active index | 0 / 3 |
| [#80](https://github.com/rohal12/spindle-lsp/issues/80) | S80 | No keyword overlap within variable identifiers | 0 / 1 |

## Expanded matrix: #70

Each cell below is an independent executable assertion. Definitions are queried
inside the apparent `Old` reference, renames are applied, unknown targets are
used for SP300 checks, and the actual runtime tokenizer confirms that markup
string/attribute contents do not contain link tokens.

| Context | References | Applied rename | Definition | Document links | Code lenses | SP300 diagnostics |
| --- | --- | --- | --- | --- | --- | --- |
| `{print "[[Old]]"}` | fail | fail | fail | fail | fail | fail |
| `<div title="[[Old]]">` | fail | fail | fail | fail | fail | fail |
| `[script]` JavaScript string | fail | fail | fail | fail | fail | pass |
| `[stylesheet]` CSS string | fail | fail | fail | fail | fail | pass |

The positive control finds both a real bracket link and a goto literal and
resolves the bracket-link definition. This shows why a diagnostic-only passage
mask does not close #70: script/style diagnostics already pass, while five
other consumers still misread the same source.

Other corpus rows sometimes contain multiple sequential assertions. Their
first failure prevents later assertions from running. Their desired rename /
rebuild checks are retained for repairs, but baseline evidence is limited to
the first observed failure. The original issue reproductions additionally
record the earlier direct probes; no full cross-product coverage is claimed.

## Work order and boundaries

1. **Transformation integrity:** #66 and #67 are P1 because edits alter meaning
   or create invalid code. #68/#69 address document targeting and EOF integrity;
   #75 applies the same edit-effect principle to completion.
2. **Source context:** #70/#71/#72 align token and passage-role decisions. #73
   keeps executable StoryInterface variables. #80 prevents overlapping keyword
   spans. Startup raw-variable validation must remain a separate view.
3. **Symbol/literal consumers:** #74 shares the widget-head grammar across
   definition/references/rename. #77 and #67 need compatible literal decoding
   and encoding; read the runtime semantics of each target-taking macro.
4. **Runtime/editor contracts:** #78 checks the unconditional startup passage
   requirement; #79 models schema variants as actual signature parameters.
5. **Public entrypoint:** #76 is independently fixable and must exercise the
   bundled executable, not only `startServer(['--stdio'])`.

No duplicate issue was closed: these contracts have distinct closure criteria.
Newly expanded #70 consumer failures belong to #70. The parent tracker groups
the work and gives shared-contract prerequisites without demanding one giant PR.

## Historical evidence and important refinements

- The line-by-line formatter placeholder boundary dates to March commits
  `ea791ace`/`bf8cd5b9`; the unencoded rename insertion to `e4a0d976`; and the
  usage-conditioned SP202 branch to `75811bdf`. This is line provenance, not a
  verified first-bad commit. These findings are baseline gaps, not established
  regressions of the latest merge.
- `MacroLink` in Spindle 0.45.1 uses its own quoted-text regex. Its target
  semantics do not match JavaScript literal evaluation. #67 must distinguish
  those cases, select a valid representation or reject an unrepresentable
  rename atomically; blindly adding JavaScript backslashes is insufficient.
- Required StoryVariables is a runtime startup requirement even without
  references. Its diagnostic severity / CLI exit-policy acceptance decision
  must be explicit in #78; the current corpus asserts diagnostic presence only.
- A single-line quoted-brace formatting candidate was excluded in the initial
  review because the installed runtime itself parsed it differently. It is not
  used as a valid-runtime formatter reproduction here.

## Remaining coverage

Not run in this new corpus: all supported Spindle versions, arbitrary UTF-16
cursor placements, all dynamic targets, comment/nested-template forms, full
document lifecycle permutations, all non-markup passage roles, every consumer
of widget/variable context, and all schema alternation/repetition forms. Some
are covered by existing unit/integration tests; that coverage has not been
enumerated cell by cell here. These are expansion candidates, not filed bugs.

For subsequent sessions, use [process.md](process.md), rerun the fixed corpus,
record changed statuses and newly added cases separately, and attach closure
evidence to the owning issue. Promote passing repaired rows into the normal
test gate. Do not restart with an unbounded independent scan after every fix.
