# Closure review, round 2 — 2026-10-06

**Assessment: converging, with two remaining demonstrated contracts.** All seven
failing probes from the preceding closure review now behave correctly, and all
61 historical case IDs remain passing. A bounded expansion found one introduced
rename regression and a surviving formatting variant. Both belong to existing
owners (#67 and #66); no new defect contracts are needed.

## Scope and fresh evidence

Reviewed `fix/review-convergence` at
`320af88718a7c19c473085ceb58f25d44bcefb41` against the preceding reviewed commit
`e26552a2699030feb3b489cfceaf767f26a09dba`. The checkout was clean at review start.
Inspected the complete production diff and changed tests/oracles, reproduced
the preceding seven cases, then expanded only the repaired contracts. Node
22.18.0; spindle-lsp 0.9.0; installed Spindle 0.45.1. The commit resolves on
GitHub, but local main/origin-main still point to `11573c1`; branch verification
does not establish merged-main behavior. No product changes, commits or pushes
were made by this review. This report is additional evidence; previous ledgers
remain historical and unchanged.

| Measurement | Previous closure review | This review |
| --- | --- | --- |
| Original 61 retained case IDs | 61 pass | 61 pass; no missing IDs |
| Seven preceding failing probes | Seven fail across five contracts | All seven repaired |
| Prior 2,605 matrix cells | 2,592 pass / 13 not-applicable | All IDs retained, all states unchanged |
| Added matrix coverage | — | 1,390 additional cells, all pass |
| Full recorded matrix | 2,605 cells | 3,982 pass / 0 fail / 0 not-run / 13 not-applicable = 3,995 |
| Normal unit/integration tests | 1,977 | 2,023 pass in 81 files |
| Remaining demonstrated owners after bounded expansion | Five | Two: #66 and #67 |

Fresh `npm test` exits 0: 81 normal files / 2,023 tests followed by 18 matrix
files / 3,995 tests. `npm run typecheck` exits 0. A separate fresh normal-suite
JSON report confirms every historical ID remains present and passing.

Fresh normal tests, typecheck **and the separate convergence matrix** also pass
on packed Spindle **0.43.0, 0.50.0, 0.50.1, 0.51.0, 0.51.1 and 0.51.3**. Together
with the installed 0.45.1 run, seven versions were checked. Each peer run has
2,023 normal tests and 3,995 matrix tests. The peer script runs only the normal
Vitest configuration and typecheck, so `docs/` was copied into each scratch
checkout and `npm run review:convergence` run separately. Do not confuse this
with rerunning all 22 releases in the historical peer ledger. Vitest includes
13 not-applicable bookkeeping cells in its passing matrix-test count.

## Disposition of the preceding seven probes

| Stable ID | Current observed behavior | Status |
| --- | --- | --- |
| `F66/do-template-lf` | Template value stays `"a\nb"` after formatting | Pass |
| `R67/goto-arithmetic-name` | Applied reference is `{goto "1 + 2"}`; target is the intended name | Pass |
| `R67/include-inline-name-0.45.1` | Target body spells `\u0069nline`; runtime reads `inline` | Pass |
| `P70/raw-do-js-link-string-0.51.3` | No reference/link inside raw body; header rename leaves `"[[Old]]"` alone | Pass |
| `D/bom-first-header/raw-source-rename` | Raw header range is characters 4–7; applied result is `\uFEFF:: New` | Pass |
| `C/variable-rename/digit-name` | `5` is accepted; applied declarations/usages and runtime parsing agree | Pass |
| `C/variable-rename/internal-dollar` | `a$b` is rejected atomically | Pass |

These are retained in the normal gate through the expanded family tables,
rename-name choices and unit/integration tests. BOM coordinates additionally
pass the new 14-case framed JSON-RPC integration tests, including full and
incremental changes, definitions, tokens and unopened disk targets. #70, #82
and #83 have no remaining demonstrated failure in this bounded review.

## Extended contract cases and remaining findings

### [P1] #66: recognize regex literals before protecting template values

Stable addition: `F66/regex-backtick-before-template`.

```twee
:: StoryVariables
:: Start
{do}
const re = /`/;
const value = `a
b`;
{/do}
```

Formatting still changes the fixed benign JavaScript value from `"a\nb"` to
`"a\n  b"`. Reproduced with both string-aware and older brace readings. Plain
template and quote-only-regex controls preserve the value.

At `src/plugins/format.ts:170`, `multilineJsLiterals()` skips slash comments but
does not recognize regex literals. It takes the regex's backtick as a template
opener at line 182, protects the wrong span up to the real template's opening
backtick, then leaves its content exposed to indentation. The value corruption
also reproduces on `e26552a`, so this is a **surviving contract gap**, not an
introduced corruption. The new scanner additionally leaves the next JS line
unindented; the actionable consequence is the changed template value.

Closure additions to the existing F family:

- Preserve exact do-body values for this regex/template sequence, LF/CRLF,
  older/string-aware readings and ordinary/HTML container wrappers.
- Keep the plain-template, slash-comment and regex-without-backtick controls.
- Recognize literal spans using JavaScript lexical context, or protect the
  executing do body as a whole; do not infer a template opener from every
  backtick outside comments.
- Retain unnormalized value comparison and formatting idempotence in the
  normal gate. The generic token-payload oracle alone is insufficient.

### [P2] #67: account for Spindle bindings before leaving a renamed target bare

Stable additions: `R67/bare-runtime-binding/_x1` and
`R67/bare-runtime-binding/URL` (the latter is an existing related gap).

```twee
:: Old
hi
:: StoryVariables
:: Start
{goto Old} {include Old}
```

Rename the first header to `_x1`. Applied source has `:: _x1` and
`{goto _x1} {include _x1}`. Spindle transforms `_x1` into
`temporary["x1"]`; with an empty temporary scope, evaluation succeeds with
`undefined`. Both consumers convert that value to the target `"undefined"`,
not the newly named passage. A populated temporary scope can instead redirect
to its stored value.

Confirmed with **the actual expression evaluator source** from 0.45.1 and
packed 0.51.3, bundled with a fixed empty story-store state (visit/render counts
and variable scopes), followed by the Goto/Include consumers' exact String /
throw-fallback rule. This is not bare JavaScript evaluation of the input text.
Compared applied edits on both commits: `e26552a` emits `{goto "_x1"}` and
navigates correctly; `320af88` emits the bare spelling and misdirects. This is
an **introduced regression**.

`src/core/parsing/link-parser.ts:578` accepts underscore-leading names as
verbatim, and `src/plugins/rename.ts:200` consequently leaves them bare. The
new `R67-bare-spelling` unit test explicitly expects `_x1` bare. Its oracle
evaluates plain JavaScript, omitting Spindle's sigil transformation; it cannot
establish the target's runtime meaning.

The same contract also remains unsafe for globals absent from the denylist,
such as `URL`: applied rename emits `{goto URL}`, and evaluation resolves the
constructor rather than the string `"URL"`. This related variant already fails
on `e26552a`; do not classify it as a new regression or create a separate ticket.

Closure additions to the existing passage rename-name choices:

- Apply both goto/include renames to `_x1` and assert the target remains `_x1`
  with empty and populated temporary scopes, on older and modern releases.
- Check `URL` and nearby literal/builtin controls through the actual Spindle
  evaluator with fixed benign fixtures; a partial browser-global denylist does
  not establish that arbitrary identifiers are unbound.
- Correct the `_x1` bare-spelling expectation using runtime evidence. Keep
  arithmetic, inline-flag, ordinary-name and quoted-reference controls passing.
- Quote or atomically reject representations that evaluate to a different
  value. Review tooling must not evaluate arbitrary project expressions.

## Convergence and next pass

The fixes repair every preceding reproduction and retain all prior matrix
states while adding executable coverage. Remaining ownership narrows from five
contracts to two. One new regression arose from replacing a conservative target
guard with a spelling heuristic, and the formatting fix still lacks one JS
lexical context. Green test totals do not close either demonstrated defect.

Reopen #66 and #67 with the cases above; keep #70, #82 and #83 closed on the
evidence inspected here. Re-run the same 61 historical cases, seven preceding
probes and these three additions on the next pass. Extend F's lexical-context
table and the passage-rename name choices with fixes, then run their consumer /
version controls and the normal gate. No new broad audit is needed to assess
these repairs. No failing desired-behavior assertion should be skipped, inverted
or weakened to obtain closure.

Posted the bounded follow-up evidence and reopened
[#66](https://github.com/rohal12/spindle-lsp/issues/66#issuecomment-6006839011)
and [#67](https://github.com/rohal12/spindle-lsp/issues/67#issuecomment-6006840058).
Updated [tracker #81](https://github.com/rohal12/spindle-lsp/issues/81) while
retaining its previous checkpoints as history. No new defect tickets were
created, and no other issue states were changed by this review.
