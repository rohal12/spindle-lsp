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
| `B/ordinary/macro-in-attr`, `B/ordinary/widget-in-attr`, `B/ordinary/link-label-interpolation` | a macro in an HTML attribute value is text; the label of a link is not interpolated | attribute values and labels hold markup; macros and variables in them are real | `passagePieces` reports `text` pieces with their tokens; `collectStoryPassageReferences` returns a `{goto 'X'}` in a `title` attribute | `link-label-interpolation [rename]` passes (the variable usages come from the pieces' tokens, B1); the other two fail (macro and passage readers) |
| every cell using `runtimeTokens` / `runtimePayload` | tokens are the top-level ones | plus the tokens inside labels and attribute values (`nested`); a semantic token is checked against the innermost token | as above | oracle widened |
| `B/ordinary/bracket-multiline` [passage-oracle] (SP304) | the link macro's regex reads a quoted part with `.` (no line break) | the target is read as a JavaScript string literal; the AST quotes `\` and `"` only, so a line break makes the macro read an expression and the click fails | `passageTarget('"a<LF>b"')` is an expression | fails |
| `C/leading-trailing-space-like/link-macro-single` | `{link "go" "Tab\tName"}` navigates to the text `Tab\tName` | the name is the JavaScript meaning (a tab) | `collectStoryPassageReferences` gives `Tab<TAB>Name` | fails |
| SP304 in general (`reads` vs `intended`) | the macro's quote regex reads a label/target differently from the token | `reads` equals `intended` except for a target the quoting cannot carry | `quoteArg` + `passageTarget` | oracle changed |
| `I/completion/attribute-value`, `I/signature/attribute-value` | macros in an attribute value are output as text: no completion, no signature help | `{` in an attribute value starts a macro: macro names are offered, signature help works; `{/` (nothing open) and `[[` (text in text mode) still offer nothing | `deepTokens` finds the nested macro | fails |
| `I/completion/variables/*/property-path` | `fields` of a declaration is a plain object | `fields` is a `Map` (`fieldNames`) | `parseStoryVariables` | passes (B1: the declarations come from `parseDeclarations`, whose `schema.fields` has the quoted keys) |
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

### Variables and declarations (scope B1)

The variable tracker reads declarations with `parseDeclarations` and usages from
the pieces of code of `passagePieces` (scanned with `lexJs`), the variable tokens
(also those in labels and attribute values), the selectors and the variable an
input macro binds (`collectVariableReferences`, `src/core/parsing/executable-refs.ts`).
Differential check, with the runtime's own `validatePassages` taken from its
bundle (it is not exported): 12142 random passages (including malformed markup,
CRLF, labels, attributes, selectors, widgets, `{do}` bodies) list the same
`$` references as Spindle's startup validation (the same names, in source order
where the runtime scans a macro's selectors after its arguments), and every
default/path pair of `field-access-runtime` and `executable-refs` gives the same
SP201 findings, but for the upstream defects below.

| Test | Old rule | New rule | Evidence |
| --- | --- | --- | --- |
| `variable-tracker` U2 (undeclared, issue example, string text, comments, script/style, `$5` and `\$cash` in prose) | before 0.50.1 Spindle validated every `$name` of the raw text; the same text was a rename usage | only what a passage executes is a reference: prose, comments, inline script/style and the text of a string are not | `validatePassages` scans tokens (`collectTokenRefs`); the bundle gives the same list as `collectVariableReferences` |
| `variable-tracker` quote in a macro head | a quote ends at the end of its line | the tokenizer reads the string across lines (`{print "a}` newline `{set $y = 1}"}` is one macro) | `tokenizeMarkupTolerant` |
| `variable-tracker` `{print name's $declared}` | `$declared` is a usage | the quote opens a string that runs on, as `lexJs` reads it (a syntax error Spindle reports) | `lexJs` |
| `variable-tracker` / `executable-refs` `{for}` locals | `{for @i of ...}` hides `@i`'s name from `$` validation | `@i` and `$i` are different variables; nothing to hide | `lexJs` sigils |
| `variable-tracker`, `field-access-runtime` SP201 (`$name.length`, `$hp.toFixed`) | members of a primitive's wrapper are rejected (before 0.51.1) | they are allowed, and the walk goes on with the member's type | `validateRef` (`PRIMITIVE_SAMPLES`) |
| `variable-tracker`, `variable-schema`, `diagnostics` SP204 | `$a = null` (also a nested null) is rejected by Spindle | a `null` default is a valid declaration of type `null`, and any field of it is accepted; SP204 reports nothing (the tracker's `getNullDeclarations()` is empty) | `parseDeclarations` gives `schema: {type: 'null'}`; `inferSchema`; `declaration-runtime` |
| `variable-tracker` `inferLiteralType`, `variable-schema` `inferDefaultSchema` | the LSP typed a default from its text | deleted with the mirror; the types come from `parseDeclarations` (more literals are typed: hex, signed numbers; quoted keys are fields: matrix M8) | `parseDeclarations` |
| `declaration-check` | the LSP reads a line with its own regex and literal reader | `readDeclarations`: `parseDeclarations` errors (wording of the tooling API: no `(\$a.b.c)` suffix, a nested unsupported value names the initializer) plus the syntax error of a value | `declaration-runtime`; `void 0`, `Math.max`... stay undetected as before; a name declared twice is no problem (the later wins) |
| `declaration-runtime` missed lines | `void 0` was flagged; `(null)`, `{get a() {...}}`, `{...{a: null}}`, `{["a"]: null}` (null is rejected) and `{f() {}}`, `x => x / 2`, `+1n` were rejected by Spindle without a finding | `void 0` is not flagged (not static); the `null` ones are valid, so no longer rejected; the method, the arrow function and `+1n` are flagged | `parseDeclarations` |
| `variable-declarations` `$5`, `%20` | `$5` in prose is a usage; `{set _t to %20}` references `%20` | prose `$5` is text; in code `%20` is the modulo operator (`transform('%20')` is a syntax error), so it is no transient anywhere | `lexJs`, `transform` |
| `hover` (fields), `semantic-tokens` S80 | `$player.health` / `$d` alone in prose are variables | they are written `{$player.health}` / `{$d}` | executable-only |
| `markup-contexts` L1-variables, L1-rename | a macro (`{if $x}`) in a bracket-link label is text | it is a macro: its `$x` is a usage, renamed with the variable | `passagePieces` |
| `link-interpolation` Q-source-registry, Q-validation-versions | the LSP classified the built-in macros by name (`LITERAL_ARGUMENT_MACROS`); raw text before 0.50.1 | deleted with the list (the macros' parameters say what holds markup); a variable in a link label is validated, one in its passage name is not | `builtinMacros` |
| `do-body-references` | the `{do}` body was tokenized like any text before 0.50.1 | those two cases are deleted (unsupported release) | `MINIMUM_SPINDLE_VERSION` |
| `inlay-hints` | the type of a default from a regex (`undefined` hinted) | from `parseDeclarations` (`undefined` and non-static defaults get no hint); widget arguments split by `splitArgs` | `parseDeclarations`, `splitArgs` |

Needs upstream API / upstream defects found (B1):

1. **Startup variable validation** (`validatePassages`, issue 464): the reference
   rules above (which `$` refs are checked; `validateRef`: array, `null`,
   primitive-wrapper members, unknown object fields) stay in the LSP
   (`executable-refs.ts`, `variable-schema.ts`). `executable-refs`,
   `field-access-runtime` and `link-interpolation` Q-validation fail on the
   oracle until it is exported.
2. `parseDeclarations` reports an unsupported value that Spindle accepts:
   `{a: undefined, a: 1}` (the later key replaces it) and
   `function () { return 1 }()` (a call). It reports `+1n` as an unsupported
   BigInt where the runtime fails to evaluate it. For a nested value, and for
   a BigInt, its message names the whole initializer (`...for value {a: 1n}`)
   or the literal (`1n`) where the runtime names the value (`undefined`, `1`).
   Tests: `declaration-runtime` "values the tooling API reads differently".
3. `parseDeclarations` gives the object `{a: 1, ...{a: {b: 1}}}` the member
   `a: number`: a later spread may replace it. Test: `field-access-runtime`
   "a member before a spread is not reliable".
4. `parseDeclarations` reports no JavaScript syntax error of an initializer
   (`$a = (1`, `$a = 1 // note`): `parseStoryVariables` fails on them when it
   evaluates. The LSP still compiles (never calls) each value with the
   `Function` constructor for its SP207 "Failed to evaluate"
   (`declaration-check.ts`); wanted: a `syntax` error code.
5. `void 0` and other expressions that are certainly `undefined` are not
   recognised (the old mirror flagged `void 0`).
