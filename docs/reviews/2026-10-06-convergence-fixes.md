# Convergence fixes — 2026-10-06

Follows [2026-10-05-convergence.md](2026-10-05-convergence.md) (61 checks: 10 pass, 51 fail).
Spindle 0.45.1, Node as installed. Branch `fix/review-convergence`, six fix branches merged.

All 15 contracts (#66–#80) now pass. Their checks moved from
`test/review/convergence.review.ts` into the normal suite with case IDs
preserved (no assertion skipped, inverted or weakened); the corpus file now
holds only shared helpers, so `npm run review:convergence` finds no tests.

Normal gate: `npm test` 63 files / 1,402 tests pass; `npm run typecheck` clean.

| Tests | Issues |
| --- | --- |
| `test/unit/format-macro-payloads.test.ts` | #66 |
| `test/unit/literal-contracts.test.ts` | #67, #70, #77 |
| `test/unit/convergence-edits.test.ts` | #68, #69, #75 |
| `test/unit/diagnostics-contracts.test.ts`, `test/integration/cli.test.ts` | #71, #72, #78 |
| `test/unit/navigation-contracts.test.ts` | #73, #74 |
| `test/integration/bin.test.ts`, `signature.test.ts`, `semantic-tokens.test.ts` | #76, #79, #80 |

Integration note: Q68-other-doc was adjusted after merge because #78 reports
SP202 once, on the owning story document; the test now locates that document.

Known gaps: Spindle `>=0.34.0` peer range unverified (see the peer-range note
once recorded); keywords are tokenized only in macro arguments, including `${}`
interpolations (string/template text excluded) -- superseded, see the
2026-10-06 closing note below: keyword tokens were removed. Spindle 0.45.1 has no keyword
sugar at all (`expression.ts` only rewrites sigils; `StoryVariables` is plain
`new Function`), so no other context is an expression for them (control
`S80-decl-control`).

Follow-ups after the first merge:

- #74: unmatched block-widget closers (no open container in the same passage;
  Spindle 0.45.1 throws "Unexpected closing") are no longer references,
  definition or rename targets (`macroHeadNames` pairing; tests G74/C-G74).
- #78: the SP202 diagnostic and its quickfix now share
  `missingStoryVariablesOwner` (H78 tests in `convergence-edits.test.ts`).
- #80: `${}` interpolation keywords restored (`S80-template*`), CRLF
  template-target cases added (`R67-template-crlf*`, `X70-template-crlf*`), and
  a UTF-16 offset bug (code-point splitting in the keyword mask) fixed.

## Closing note: signature help, keywords, widget sigils, rename (2026-10-06)

Branch `fix/close-n-sig`, Spindle 0.45.1 (source and `dist/pkg` inspected).

**Signature help (N-sig).** The active signature now follows the arguments
typed so far: each completed argument (everything before the one under the
cursor) must be accepted by its slot, using the validator's own format-tree
crawl (`ParameterSlot.accepts`, so variables/expressions always fit, type
warnings are not rejections). Preference order: accepts prefix and has the
active position, then accepts prefix, then has the position. Parameters are
named from the new optional `parameterDocs` (name + help per position) in
`macro-supplements.json` / user config; every built-in macro with parameters
has them (`N-sig-name-2`). Slot types are always in the documentation, and
when alternatives would otherwise share a label the labels add the type
(`flag: number`). The old H79 label expectations (`receiver`, `text`) were
replaced by the descriptive names; the `set` documentation now reads
`{set $var = value}` (see next item). Tests: `N-sig-*` in
`test/unit/signature.test.ts` (13 new; 13 fail on the previous code).

**Keyword tokens (S80).** Decision: removed. Evidence: the tokenizer was
introduced with the first semantic-tokens commit (317b8a2, 2026-03-22) as a
port of SugarCube-style sugar (`to is isnot eq neq gt gte lt lte and or not
def ndef`). No Spindle release has it: `expression.ts` only rewrites the
`$ _ @ %` sigils and compiles with `new Function`; `{set}` passes its raw
arguments to that; `new Function('v','return v.x to 1')` throws "Unexpected
identifier 'to'"; grepping the published packages 0.1.0, 0.10.0, 0.20.0,
0.34.0, 0.43.1 and 0.45.1 finds no `isnot`/`sugar`; the repository README,
`package.json` (this repository has no CHANGELOG) and docs mention no such feature. A
highlighted keyword that is a plain identifier at runtime is a wrong signal,
so `computeSemanticTokensAbsolute` no longer emits `keyword` tokens (the legend
keeps the entry so indexes stay stable). The S80 tests now assert that no
keyword token exists in any context and keep the guarantees that matter:
whole-variable tokens for `$is`/`$to`/`$not`, no overlaps, UTF-16 columns
under CRLF and astral characters, `${}` interpolation variables.

**Widget names starting with `_` or `$` (proven not a defect).** Spindle's
tokenizer reads `{` followed by `$ _ @ %` as a variable or expression, also
after selectors (`{.c _w 1}`), and a macro only when the name starts with a
letter. Run against `tokenize()`: `{_w 1}`, `{$w 1}`, `{@w 1}`, `{%w 1}` and
`{.c _w 1}` all yield one `expression` token; `{w 1}`/`{w-x 1}` yield macros.
So such a widget can be registered but never invoked, and the shared grammar
is right. Control tests `N-widget-sigil` / `C-N-widget-sigil` in
`navigation-contracts.test.ts` (runtime tokenizer plus references, definition,
prepareRename, rename).

**Rename (N-rename).** LSP gives `prepareRename` only a position, never the
new name, so name validity cannot be decided there; the specified channel is
failing the `rename` request with a message (a partial WorkspaceEdit would
corrupt the story). Already atomic; now also consistent and located:
`RenameError` carries `uri`/`range` and its message ends with
`(at <uri>:<line>:<col>)` naming the reference (bracket link, `{link}` string)
or declaration that cannot hold the name. New up-front checks on the same
path: passage header (empty, line breaks, leading/trailing whitespace),
variable (must be an identifier after optional sigil), widget (callable
`{name}` and not shadowed by a macro). Test `N-rename-consistent` asserts that
whatever `prepareRename` accepts can be renamed to its own placeholder.
Tests: `N-rename-*` in `test/unit/rename.test.ts` (8 new; 6 fail on the
previous code).
