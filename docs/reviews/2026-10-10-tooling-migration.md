# Migration to the Spindle tooling API (0.59.x)

Status: in progress. spindle-lsp's minimum Spindle is 0.59.20 (devDependency
0.59.23). Its parsing is being moved from hand-written mirrors of the runtime's
rules onto `@rohal12/spindle/tooling` (see `docs/tooling.md` in Spindle).

## Runtime changes since the 0.45.1/0.51.3 audit that change contracts

- `{goto}`, `{include}`, `{link}` take a `passage` argument: a quoted string is
  a name (read as a JavaScript literal, `passageTarget`), anything else is an
  expression evaluated at run time (`evaluatePassageName`). **There is no text
  fallback**: a bare name (`{goto Old}`) is an expression and throws a
  ReferenceError (Spindle reports `unquoted-passage-name`).
- `{include}`'s `inline` flag: `splitIncludeFlag` (first or last word outside
  quotes and brackets).
- Code is read with acorn at story start (`code-syntax` diagnostics).

## Oracle layer

(cells whose expectation encoded runtime behavior that no longer exists are
listed under "Cell dispositions" with the runtime evidence; none is deleted or
skipped.)

### How the oracle layer reads the runtime now

The oracle is the public tooling API, through `test/helpers/*.ts`; nothing
imports `node_modules/@rohal12/spindle/src/...` any more.

| Need | Public API used |
| --- | --- |
| tokens | `tokenizeMarkupTolerant(lf).tokens` (`helpers/tooling.ts` `tokenize`) |
| the tokens of markup inside labels and attribute values | `passagePieces(lf, builtinMacros)`: the `tokens` of each `text` piece (`deepTokens`; `OracleToken.nested`) |
| passage names the runtime resolves | `collectStoryPassageReferences(lf, builtinMacros)`, kind `name` only (LF offsets mapped back to the CRLF document; the span compared is the enclosing top-level token) |
| where `{goto}`/`{include}` go | `splitIncludeFlag`, `passageTarget`, `evaluatePassageName` over a `new Function(...)` evaluator of `transform(expr)` (`helpers/expression-oracle.ts`); null when it throws |
| what the link macro reads | `passagePieces('{link ' + args + '}')`; a bracket link is first turned into `{link "label" "target"}` with the AST's `quoteArg` rule (`helpers/link-macro-oracle.ts`) |
| "the runtime rejects this passage" | the first error of `tokenizeMarkupTolerant` then `pairMarkup` (what `parseMarkup` throws; `helpers/runtime-ast.ts`), not `validateMarkup`, which also reports unknown macros, code syntax and passage names |
| `{do}` body | `passagePieces`: a `code` piece with goal `statements` |
| StoryVariables | `parseStoryVariables` (`fields` is a `Map`; `helpers/story-variables-oracle.ts` `fieldNames`) |
| variables the runtime reads | `deepTokens` plus the `.class#id` selectors (`helpers/variable-reads-oracle.ts`) |

### Needs upstream API

Capabilities the oracle layer cannot get from `@rohal12/spindle/tooling` (or
`/headless`, which needs a DOM this repository's test environment lacks):

1. **Startup variable validation** (`validatePassages(passages, schema)`:
   "Undeclared variable: $x" and "Cannot access field ..." for a story).
   Not exported; `story-variables.ts` cannot be imported under vitest (it
   pulls in the Peggy grammar). `helpers/story-variables-oracle.ts`
   `validatePassages` throws "needs upstream API". Affects
   `field-access-runtime`, `executable-refs` and the Q-validation tests of
   `link-interpolation`. Wanted: `validateVariableReferences(passages, schema,
   macros)` or a `schema` option of `validateStoryMarkup`.
2. **Text-mode interpolation** (`interpolate(template, scopes)`: attribute
   values, labels). `helpers/interpolation-oracle.ts` is the closest public
   equivalent (text-mode `tokenizeMarkupTolerant` + `pairMarkup` +
   `transform`), modelling text, variables, expressions, `{if}` and `{print}`;
   the `{for}`/`{switch}` text forms throw. Wanted: a pure `renderText` /
   `interpolate` in the tooling entry point. Affects `attribute-blocks-runtime`,
   `link-interpolation` and `markup-differential` (SP103, SP305 and variable
   reads).

### Cell dispositions

Matrix cell names, dimensions and properties are unchanged; none is skipped,
inverted or weakened. A cell listed as "fails" disagrees with the runtime
because `src/` still carries the old mirror, and stays failing until `src/`
follows. `docs/reviews/2026-10-06-cross-consumer-results.json` has not been
regenerated: it still records the old statuses (run the matrix with
`REVIEW_PARTIAL=1` until `src/` is done).

| Cell / family | Old rule | New rule | Evidence | State |
| --- | --- | --- | --- | --- |
| `B/ordinary/goto-bare-identifier`, `B/ordinary/include-bare`, `C/include-widget-other-bare/*`, `C/include-widget-other-flag-before/*` [passage-oracle, rename] | a bare `{goto Old}` navigates to `Old` (text fallback when evaluating throws) | the bare word is an expression; evaluating it throws, so it is not a reference (the oracle lists none) and a rename must quote | `passageTarget('Old')` is `{kind:'expression'}`; `validateMarkup` reports `unquoted-passage-name`; `collectStoryPassageReferences` returns nothing | fails (src reads bare names) |
| `B/ordinary/goto-template` [passage-oracle] | a backtick literal is a static name | only `"..."` and `'...'` are names; a template is an expression | `passageTarget` of a backtick literal is an expression | fails |
| `A/*/bracket-in-comment`, `B/ordinary/goto-in-comment`, `B/ordinary/widget-in-comment`, `B/ordinary/html-comment-multiline` | `[[x]]`, `{goto}` and `{widget}` inside `<!-- -->` are tokens | a closed HTML comment is one `text` token (`comment: true`) | `tokenizeMarkupTolerant('<!-- [[x]] -->')` is one comment text token; `validateMarkup` reports no missing passage for it | fails |
| `B/ordinary/macro-in-attr`, `B/ordinary/widget-in-attr`, `B/ordinary/link-label-interpolation` | a macro in an HTML attribute value is text; the label of a link is not interpolated | attribute values and labels hold markup; macros and variables in them are real | `passagePieces` reports `text` pieces with their tokens; `collectStoryPassageReferences` returns a `{goto 'X'}` in a `title` attribute | fails |
| every cell using `runtimeTokens` / `runtimePayload` | tokens are the top-level ones | plus the tokens inside labels and attribute values (`nested`); a semantic token is checked against the innermost token | as above | oracle widened |
| `B/ordinary/bracket-multiline` [passage-oracle] (SP304) | the link macro's regex reads a quoted part with `.` (no line break) | the target is read as a JavaScript string literal; the AST quotes `\` and `"` only, so a line break makes the macro read an expression and the click fails | `passageTarget('"a<LF>b"')` is an expression | fails |
| `C/leading-trailing-space-like/link-macro-single` | `{link "go" "Tab\tName"}` navigates to the text `Tab\tName` | the name is the JavaScript meaning (a tab) | `collectStoryPassageReferences` gives `Tab<TAB>Name` | fails |
| SP304 in general (`reads` vs `intended`) | the macro's quote regex reads a label/target differently from the token | `reads` equals `intended` except for a target the quoting cannot carry | `quoteArg` + `passageTarget` | oracle changed |
| `I/completion/attribute-value`, `I/signature/attribute-value` | macros in an attribute value are output as text: no completion, no signature help | `{` in an attribute value starts a macro: macro names are offered, signature help works; `{/` (nothing open) and `[[` (text in text mode) still offer nothing | `deepTokens` finds the nested macro | fails |
| `I/completion/variables/*/property-path` | `fields` of a declaration is a plain object | `fields` is a `Map` (`fieldNames`) | `parseStoryVariables` | fails (completion offers no fields for `{"a": ..., "name": ...}`) |
| `I/completion/closing-tag/*` | `registerBlockMacro` / `buildAST` | `pairMarkup` with the story's block widget in `isBlock` | `runtimeMarkupFailure` | passes |
| `N/spindle-version-state` | the corpus runs against packed releases | no per-release behavior; the minimum is 0.59.20 | `MINIMUM_SPINDLE_VERSION` | note text only |

Unit tests whose expectation or oracle changed with the runtime (names kept
unless stated):

| Test | Old rule | New rule |
| --- | --- | --- |
| `rename-target-encoding` R67-runtime-oracle, R67-bare-spelling | a bare name stays bare when it throws; `runtimeGotoTarget('Chapter 2')` is `'Chapter 2'` | no text fallback: null (throws); every name is spelled quoted |
| `rename` N-rename-offender-other-file | `Bob"s` cannot be written in a `{link}` | the link macro reads a JavaScript literal, so `Bob\"s` fits; the offender is a bracket link and the name `a\|b` |
| `link-interpolation` Q-source, Q-differential, Q-diagnostic (messages, ranges, expected count), Q-rename | the link macro prints its label as written; SP305 flags label blocks | the label is markup (`link` declares `text` as `string`/`markup`, as does `meter`); only the passage name is taken as written |
| `markup-differential` D1 (renamed: macros in bracket-link labels are macros), C-D1-quote, D3 macro oracle | macros in a label are text; `/(["'])(.*?)\1/g` reads the link | labels hold markup (`deepTokens`); the link macro reads JavaScript literals |
| `macro-head-differential` H-names, H-vendored | `{x{$y}}` is `x{$y}`; `{/.cls if}`, `{/}`, `{/ x}` close a macro named `.cls`, `` | braces in a head are matched (`x{$y`); those closers are text with an `invalid-closer` error; the vendored 0.51.3 tokenizer is replaced by the installed one |
| `diagnostics-attribute-blocks` (whitespace around `=`) | `<a href = "x">` is text | it is a tag with `href` = `x` |
| `macro-pairing-runtime`, `element-macro-differential` | `buildAST` throws "Expected {/x} but found {/y}" at a character | `pairMarkup` errors: `mismatched-closer` / `stray-closer` / `unclosed-block` with `start` |
| `do-body` D-runtime | `collectText` of the `{do}` children | `passagePieces`: the body is a `statements` code piece |
| `attribute-blocks-runtime` SP103 | only `{sigil...}` blocks of an attribute value are evaluated | attribute values hold markup: `{if}` / `{print}` are evaluated too (the test now fails; SP103's premise is gone) |

### Formatting and entrypoints (scope D)

The formatter reads markup with `tokenizeMarkupTolerant` (macros, variables,
expressions, links, and the macros/variables in HTML attribute values), takes
the JavaScript of a `{do}` body from the tokenizer (one raw text token) and
its literals from `lexJs`/`lexTemplate`, and finds the macro tags that open and
close bodies and the places where a prose line can wrap from the same tokens.
`FormatOptions.stringAwareBraces`, `scanBalancedBrace*`, the selector scanner,
the regex/template heuristics and the `{do}` regexes are gone; the CLI, the MCP
tools and the LSP request pass no version-dependent option. The Spindle version
of a project (`findSpindleTarget`: installed copy, then StoryData) only warns
when it is older than `MINIMUM_SPINDLE_VERSION` (CLI: stderr; MCP: a `warning`
field; LSP: the existing startup log, window message and SP001).

| Test | Old rule | New rule |
| --- | --- | --- |
| `integration/cli.test.ts` "reports undeclared variables in StoryInit..." (#62), `integration/lsp.test.ts` "publishes SP200 ..." (#62) | pre-0.50.1 raw-text validation reports `$missingProse` and `$missingLiteral` (prose and a string literal) | Spindle >= 0.50.1 validates the variables the code reads (`variable-reads-oracle`: `lexJs` leaves `$x` in a string literal alone, prose is text): only `missingInit`, `missingTemplate`, `missingReceiver`, `missingCode` |
| `unit/format-brace-reading` Q-format-0.50.0 | a stray `{` in a string extends the macro to the next `}` | removed: one reading; the macro ends at its own `}` (Q-format-stray-brace) |
| `unit/placeholders-oracle` K66-scan fixtures | the hand scan was compared with the tokenizer | the scan is the tokenizer's; the oracle is `deepTokens` (`passagePieces` for attribute values), plus `{do}`-body fixtures |
| `unit/spindle-capabilities` SP001 | floor 0.43.0 (transients), second SP001 on a StoryTransients passage | floor `MINIMUM_SPINDLE_VERSION` (0.59.20), one SP001 on the first story document |

Deleted with the per-release machinery (each tested a flag that is true on every
supported release, or the hand scan that is gone):

- `unit/spindle-capabilities`: "gates each behavior at the release that
  introduced it", "defaults to the behavior pinned by the 0.45.1 tests",
  "SP200/SP201 keep raw-text validation below 0.50.1", "SP200/SP201 still read
  prose below 0.50.1...", "allows primitive wrapper members from 0.51.1 only",
  "from 0.50.1 SP200/SP201 report executable references only" (the modern rule is
  the default and covered by `variable-tracker`), and the `WorkspaceModel`
  `.capabilities` cases. Kept and ported: version parsing, installed-then-
  StoryData resolution, the unsupported-version warning.
- `unit/format-brace-reading`: Q-format-wrong-reading (compared the two
  readings), the `findSpindleCapabilities` cases and the per-release
  CLI/MCP/LSP cases; replaced by "one reading in every entrypoint".
- `unit/placeholders-oracle`: the `stringAwareBraces` mode tests and "the
  capability follows the installed release".
