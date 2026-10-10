# Migration to the Spindle tooling API (0.59.x)

Status: **complete on the branch, with four tests waiting on upstream**.
spindle-lsp's minimum Spindle is 0.59.20 (`MINIMUM_SPINDLE_VERSION`; devDependency
0.59.25, bundled into the executable). Its parsing, which was a set of
hand-written mirrors of the runtime's rules checked by differential tests, is
now `@rohal12/spindle/tooling` read through `workspace.markup`
(`src/core/markup`): the tolerant tokens with sub-spans, the paired tree, the
code/passage/text pieces, declarations, widget definitions, variable
references and validation, and the markup validation behind the diagnostics.

## Final state

| Measure | Before (main, Spindle 0.45.1) | After |
| --- | --- | --- |
| Matrix (`npm run review:convergence`) | 3,995 cells | 5,209 cells, all pass (`docs/reviews/2026-10-06-cross-consumer-results.json` regenerated; cell names unchanged, cells added by earlier reviews retained) |
| Unit + integration | 2,070 tests | 1,956 tests, 1,952 pass; 4 fail, all waiting on spindle#466 (see below). Test code: 22,373 to 19,793 lines |
| `src/` (TypeScript lines) | 16,171 | 11,541 (-29%); `core/parsing` mirrors deleted: macro-parser, html-scanner, code-scanner, attribute-blocks, widget-arguments, the literal reader, the tracker's validation |
| Per-release behavior | 6 capability flags, packed-release matrix | none; releases below 0.59.20 get a warning |

The "State" cells in the per-scope tables below record the state when that
scope landed; the matrix is green as a whole.

### Upstream tickets (rohal12/spindle)

Delivered and used: #241, #446-#451 (stateless checks, diagnostic codes and
ranges, pairing, declarations, token sub-spans, passage pieces), #462
(widget definitions), #464 (variable validation).
Open, with the local code that waits on each:

| Ticket | What | Waiting |
| --- | --- | --- |
| #466 | `parseDeclarations` disagrees with the runtime on some initializers | 4 tests: `declaration-runtime` (3), `field-access-runtime` (1) |
| #467 | `widgetDefinitions` says `block:false` for `{@children}` in an attribute value | docs/behavior mismatch only |
| #468 | complete variable references (`{unset}`/`{computed}` receivers, selector names) and a static reading of `Story.defineMacro` | `executable-refs.ts` extras, `macro-discovery.ts` |
| #469 | `validateStoryMarkup` should go past a malformed tag | the `wellFormed` workaround in `diagnostics.ts` is to be deleted |
| #470 | `parseWidgetDef` keeps the comma of `@a,` | none |

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
inverted or weakened. The State column is the state when the scope landed
(a cell that "fails" there disagreed with the runtime because `src/` still had
the old mirror); every cell passes now and the results file is regenerated.

| Cell / family | Old rule | New rule | Evidence | State |
| --- | --- | --- | --- | --- |
| `B/ordinary/goto-bare-identifier`, `B/ordinary/include-bare`, `C/include-widget-other-bare/*`, `C/include-widget-other-flag-before/*` [passage-oracle, rename] | a bare `{goto Old}` navigates to `Old` (text fallback when evaluating throws) | the bare word is an expression; evaluating it throws, so it is not a reference (the oracle lists none) and a rename must quote | `passageTarget('Old')` is `{kind:'expression'}`; `validateMarkup` reports `unquoted-passage-name`; `collectStoryPassageReferences` returns nothing | fails (src reads bare names) |
| `B/ordinary/goto-template` [passage-oracle] | a backtick literal is a static name | only `"..."` and `'...'` are names; a template is an expression | `passageTarget` of a backtick literal is an expression | fails |
| `A/*/bracket-in-comment`, `B/ordinary/goto-in-comment`, `B/ordinary/widget-in-comment`, `B/ordinary/html-comment-multiline` | `[[x]]`, `{goto}` and `{widget}` inside `<!-- -->` are tokens | a closed HTML comment is one `text` token (`comment: true`) | `tokenizeMarkupTolerant('<!-- [[x]] -->')` is one comment text token; `validateMarkup` reports no missing passage for it | the semantic-token halves (`[macro-oracle]` of `goto-in-comment`) pass since `semantic-tokens.ts` reads `macroTokens`; the reference halves fail until the reference scanners follow |
| `B/ordinary/macro-in-attr`, `B/ordinary/widget-in-attr`, `B/ordinary/link-label-interpolation` | a macro in an HTML attribute value is text; the label of a link is not interpolated | attribute values and labels hold markup; macros and variables in them are real | `passagePieces` reports `text` pieces with their tokens; `collectStoryPassageReferences` returns a `{goto 'X'}` in a `title` attribute | `link-label-interpolation [tokens]` now fails too: the semantic tokens (correctly) mark `$v` in the label, the variable tracker does not record it yet, and that cell requires a `$` token to be a reference to some consumer; passes when the tracker follows (its `[rename]` cell fails for the same reason) |
| `A/*/bracket-in-comment`, `B/ordinary/goto-in-comment`, `B/ordinary/widget-in-comment`, `B/ordinary/html-comment-multiline` | `[[x]]`, `{goto}` and `{widget}` inside `<!-- -->` are tokens | a closed HTML comment is one `text` token (`comment: true`) | `tokenizeMarkupTolerant('<!-- [[x]] -->')` is one comment text token; `validateMarkup` reports no missing passage for it | fails |
| `B/ordinary/macro-in-attr`, `B/ordinary/widget-in-attr`, `B/ordinary/link-label-interpolation` | a macro in an HTML attribute value is text; the label of a link is not interpolated | attribute values and labels hold markup; macros and variables in them are real | `passagePieces` reports `text` pieces with their tokens; `collectStoryPassageReferences` returns a `{goto 'X'}` in a `title` attribute | fails |

| `B/ordinary/goto-bare-identifier`, `B/ordinary/include-bare`, `C/include-widget-other-bare/*`, `C/include-widget-other-flag-before/*` [passage-oracle, rename] | a bare `{goto Old}` navigates to `Old` (text fallback when evaluating throws) | the bare word is an expression; evaluating it throws, so it is not a reference (the oracle lists none) and a rename must quote | `passageTarget('Old')` is `{kind:'expression'}`; `validateMarkup` reports `unquoted-passage-name`; `collectStoryPassageReferences` returns nothing | passes (references, rename and document links read `passagePieces`); `C/include-widget-other-bare` and `C/include-widget-other-flag-before` [rename] wait for SP302, which still resolves a bare `{include Other}` as a name (`resolveIncludeTarget` in diagnostics.ts) |
| `B/ordinary/goto-template` [passage-oracle] | a backtick literal is a static name | only `"..."` and `'...'` are names; a template is an expression | `passageTarget` of a backtick literal is an expression | passes |
| `A/*/bracket-in-comment`, `B/ordinary/goto-in-comment`, `B/ordinary/widget-in-comment`, `B/ordinary/html-comment-multiline` | `[[x]]`, `{goto}` and `{widget}` inside `<!-- -->` are tokens | a closed HTML comment is one `text` token (`comment: true`) | `tokenizeMarkupTolerant('<!-- [[x]] -->')` is one comment text token; `validateMarkup` reports no missing passage for it | [passage-oracle] cells pass; the [macro-oracle] cells (`goto-in-comment`, `widget-in-comment`: semantic tokens) wait for the macro parser |
| `B/ordinary/macro-in-attr`, `B/ordinary/widget-in-attr`, `B/ordinary/link-label-interpolation` | a macro in an HTML attribute value is text; the label of a link is not interpolated | attribute values and labels hold markup; macros and variables in them are real | `passagePieces` reports `text` pieces with their tokens; `collectStoryPassageReferences` returns a `{goto 'X'}` in a `title` attribute | `macro-in-attr` [passage-oracle, rename] pass; `widget-in-attr` (widgets) and `link-label-interpolation` [rename] (variables) wait for their owners |

| `B/ordinary/macro-in-attr`, `B/ordinary/widget-in-attr`, `B/ordinary/link-label-interpolation` | a macro in an HTML attribute value is text; the label of a link is not interpolated | attribute values and labels hold markup; macros and variables in them are real | `passagePieces` reports `text` pieces with their tokens; `collectStoryPassageReferences` returns a `{goto 'X'}` in a `title` attribute | `link-label-interpolation [rename]` passes (the variable usages come from the pieces' tokens, B1); the other two fail (macro and passage readers) |
| every cell using `runtimeTokens` / `runtimePayload` | tokens are the top-level ones | plus the tokens inside labels and attribute values (`nested`); a semantic token is checked against the innermost token | as above | oracle widened |
| `B/ordinary/bracket-multiline` [passage-oracle] (SP304) | the link macro's regex reads a quoted part with `.` (no line break) | the target is read as a JavaScript string literal; the AST quotes `\` and `"` only, so a line break makes the macro read an expression and the click fails | `passageTarget('"a<LF>b"')` is an expression | passes (`findLinkRuntimeMismatches` reads a bracket target that has a line break through `passagePieces`) |
| `C/leading-trailing-space-like/link-macro-single` | `{link "go" "Tab\tName"}` navigates to the text `Tab\tName` | the name is the JavaScript meaning (a tab) | `collectStoryPassageReferences` gives `Tab<TAB>Name` | passes |
| SP304 in general (`reads` vs `intended`) | the macro's quote regex reads a label/target differently from the token | `reads` equals `intended` except for a target the quoting cannot carry | `quoteArg` + `passageTarget` | oracle changed |
| `I/completion/attribute-value`, `I/signature/attribute-value` | macros in an attribute value are output as text: no completion, no signature help | `{` in an attribute value starts a macro: macro names are offered, signature help works; `{/` (nothing open) and `[[` (text in text mode) still offer nothing | `deepTokens` finds the nested macro | passes (`markup-cursor.ts` reads the macros of the text pieces and the errors of a macro still being typed) |
| `I/completion/variables/*/property-path` | `fields` of a declaration is a plain object | `fields` is a `Map` (`fieldNames`) | `parseStoryVariables` | fails: completion reads `workspace.variables.getDeclared().get(name).fields`, which the variable tracker (not this scope) still extracts with a regex; passes when it reads `parseDeclarations` |

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

### Registries, variable tracker internals and the workspace model (scope W2b)

`WidgetRegistry` reads the definitions of the workspace with `widgetDefinitions`
(`StoryInit` and the passages tagged `widget`, as the runtime registers them;
name, `@` parameters, block-ness and the spans of the tag, the name and the
closer), and the widgets a document calls from the macro tokens of
`workspace.markup` (the top-level ones and those in labels and attribute
values), no regex scan. The calls the widget navigation lists
(`src/core/markup/macro-heads.ts`: references, definition, prepare rename,
rename) are the macro heads of the paired tree. The workspace cascade starts
with `markup.invalidate()`, scans the widgets, and then reads the variable
usages and invocations from the same markup, which pairs its tags with the
widgets just defined. The variable tracker's `$`/`%` references are the tooling
API's `variableReferences` (macros carry `storeVar`; the registry's tooling
macros now pass it), plus the two kinds of reference the API does not return and
rename needs (not validated): the variable a macro with a `variable` parameter
names (`{unset $x}`, `{computed $x = ...}`) and the `{$name}` of a link's
selectors. `_` and `@` references have no consumer any more (the
`executableCode` text blanker was only used by a function nothing called) and
are gone. Discovered macros carry the typed `parameters` of their
`Story.defineMacro` call (`parameterDefs`), which is what lets `passagePieces`
tell code from text in the arguments of a project's macro.

| Test / cell | Old rule | New rule | Evidence |
| `B/ordinary/widget-in-comment` [macro-oracle], `widget-in-attr` [macro-oracle] [rename] | widget calls come from a regex over the text (a call in a comment counts, one in an attribute value does not) | the calls the tokenizer reads: none in a comment, those in attribute values and labels | `tokenizeMarkupTolerant`, `passagePieces`; `findWidgetReferences` agrees with the oracle's heads |
| `B/ordinary/widget-in-comment` [rename] | rename edits `{wid}` in `<!-- ... -->` too | the comment is text: it is not edited; SP100 on the now unknown `{wid}` in a comment is a diagnostics defect (the scanner there still reads macros in comments) | fails until SP100 reads macro tokens (diagnostics scope) |
| `widget-registry`, `hover` "declared sigil", `completions` "parameters of its widgets", `diagnostics` "recognizes widgets..." | `$a`, `_b`, `@c` after a widget's name are parameters (the old regex scan of Spindle's 0.4x startup) | only the `@` names are (`parseWidgetDef`); `@children` is kept when written, as the runtime returns it | `parseWidgetDef('"mix" $a _b @c junk')` is `{name: 'mix', params: ['@c']}` |
| `widget-registry` "marks widgets whose body contains {@children}" | a `{@children}` anywhere in the body (text search) | decided on tokens: in a comment it does not count, in a label it does | `widgetDefinitions` (`block`) |
| `navigation-contracts` C-W74 | an HTML attribute value is text: `<a title="{greeting}">` is no call | it holds markup: it is a call (the string of `{print}` and a comment are not) | `passagePieces` |
| `markup-contexts` L4 (crossed containers), `element-macro-differential` widget heads | the closer of a container that is closed out of order stays with it | unchanged: `pairMarkup` leaves what is inside a closed-over container unclosed and drops its later closer as stray; the heads re-attach that stray closer to the unclosed macro of its name written before it (`macro-heads.ts`) | `pairMarkup` errors |
| `variable-tracker` references in a passage with a malformed tag | not validated (the story does not start) | validated: `variableReferences` is tolerant, as `validateVariableReferences` is | tooling API |
| `macro-registry` "reads the registry of the Spindle installed in the workspace", "falls back to the LSP's own copy" | the registry was read from the workspace's `dist/pkg/macro-registry.json` | deleted with the file reader: the built-in macros are the tooling API's `builtinMacros` | `loadBuiltins()` |
| `variable-tracker` `executableCode` | text blanker keeping only variable references (`_`, `@` too) | deleted with `executableCodeLines` (references.ts): nothing used them | no consumer |

The oracle of the differential tests that needed `validatePassages`
(`executable-refs`, `field-access-runtime`, `link-interpolation` Q-validation)
is now `validateVariableReferences` (`test/helpers/story-variables-oracle.ts`);
those cases pass again except for the upstream defects above (spindle#466).

Needs upstream API / observed upstream behavior (W2b):

1. `widgetDefinitions` decides `block` on tokens, and the documentation says a
   `{@children}` in an attribute value or a label counts; in an HTML attribute
   value (`<p title="{@children}">`) it does not (`block: false`); in a label
   (`{button "{@children}"}`) it does. One of them is wrong.
2. `variableReferences` returns neither the variable a macro declares
   (`{unset $x}`, `{computed $x ...}`), as documented, nor the `{$name}` of a
   link's selectors (`[[.c{$sel} go->T]]`). Rename and references need them; they
   are read locally (`executable-refs.ts`), marked not validated. An option to
   return every reference (also those the story start does not check) would let
   them go.
3. There is no static reading of `Story.defineMacro({...})` calls
   (name, flags, typed `parameters`) in the tooling API: `macro-discovery.ts`
   reads the config object with `findCodeEnd`, `splitTopLevel` and `readQuoted`
   (comments and nested objects are handled), the parameters with the table of
   `ParameterType`s of the documentation.

### Diagnostics and code actions (scope W2a)

`computeDiagnostics` is assembled from the tooling API instead of re-reading
the markup:

| Diagnostics | Source |
| SP100, SP105, SP106, SP109, SP113, SP300, and the malformed markup in a label or an attribute value | `validateStoryMarkup` over every passage of the workspace (once per version of the workspace's markup, kept per workspace), through `PassageMarkup.range` |
| SP101, SP102, SP104, SP105, SP107 (`misplaced-branch`) for the tags of a passage | `PassageMarkup.tokenization.errors` and `.pairing.errors`: all of them, where `validateStoryMarkup` reports the first of a passage |
| SP200, SP201, SP203, SP208 | `validateVariableReferences` with the declarations of `parseDeclarations`, per passage |
| SP207 | the variable tracker (`parseDeclarations` errors plus the syntax check), unchanged |
| SP107 (`{option}`, `{stop}`, configured parents), SP114, SP115, SP205 | the paired tree of the passage (`pairing.nodes`) and the registry's `children`/`parents` |
| SP301, SP302, SP303 | `widgetDefinitions`, `splitArgs`, the `include` pieces of `passagePieces` |
| SP304, SP305 | `findLinkRuntimeMismatches`, `findLiteralLinkInterpolations` (link-parser.ts) |
| SP001, SP202, SP206, SP500 | as before (version target, tracker, array members, line length) |

`validateStoryMarkup` stops at the first malformed tag of a passage (the story
does not start there) and checks nothing else of it. The editor wants the rest
(an unknown macro or a broken link beside an unclosed `{if}`), so each malformed
passage is validated in a copy whose malformed or unpaired tags are replaced by
spaces (`wellFormed`; every offset stays), and its tags are reported from the
tolerant tokenizer and `pairMarkup`, which report all of them. See "Needs
upstream API" below.

New codes: SP105 (`unclosed-link|expression|macro`), SP106 (`code-syntax`),
SP113 (`unquoted-passage-name`), SP208 (`reserved-name`); SP109 now is Spindle's
`argument-error`. Removed: SP103, SP204 (below), SP112 (never reported). SP108,
SP110, SP111 stay for a macro that only the project's configuration describes
(`parameters` in the registry's format), not for the macros Spindle defines.
Every diagnostic carries `data` (`DiagnosticData`) for the quick fixes: change an
unknown macro or broken link to the closest name (`suggestions`), create the
passage of a broken link, insert the missing closing tag of an unclosed block or
element, quote a bare passage name, declare an undeclared variable.

Unit tests whose expectation changed with the runtime:

| `diagnostics`, `diagnostics-*`, `do-body`, `macro-head-differential`, `markup-contexts`, `passage-references`, `variable-declarations`, `macro-discovery`, integration `cli`/`lsp`/`mcp` (messages) | the LSP worded SP100 "Unrecognized macro: {x}", SP101 "Malformed container: ...", SP102 "Malformed element: ...", SP104 "Illegal closing tag: ...", SP200 "Variable '$x' is not declared in StoryVariables", SP300 "Passage "X" not found in workspace" | Spindle's wording: "Unknown macro {x}. Did you mean {y}?", "Unclosed {if}: no {/if} closes it", "{/x} closes nothing: no {x} is open here", "{/if} found where </p> should close the <p> opened at line 1, column 8", "Undeclared variable: $x", `No passage named "X" in [[X]].` (the label or attribute value a diagnostic is in is named first: "In the class attribute of <span>: ...") | `MarkupDiagnostic.message` |
| `diagnostics-malformed-element`, `diagnostics-containers`, `diagnostics-contracts` X71 | SP102 stops at the first error of a passage; `<a href = "x">` is text; a closed `<!-- <div> -->` holds tags; `[[unclosed` is text; macros in a link label are text; `{/}` is a macro closer | every pairing error is reported, the tag with spaces around `=` is a tag, a comment is one text token, an unclosed `[[`, `{$` or `{name` is SP105, macros in labels and attribute values are macros (paired, checked, SP101/SP100/SP107 in them), `{/}` is SP104 and reading goes on | `pairMarkup`, `tokenizeMarkupTolerant` |
| `diagnostics-validation`, `diagnostics-containers` {timed}/{next} | the LSP's argument schema (`macro-supplements.json`) rejected `{goto}`, `{include}`, `{textbox 42 "x"}`, `{dialog "Open" extra}`, `{timed 1s 2s}` (SP108-SP111); `{goto Chapter 1}` and `{include Name}` fell back to the text | Spindle declares the parameters of its macros and reports only `argument-error` (SP109, e.g. `{link Go}`); the others are not rejected by the runtime. A bare word or several words is an expression: `unquoted-passage-name` (SP113) or `code-syntax` (SP106). The schema checks configured macros only | `validateStoryMarkup` |
| `diagnostics` SP301 ($/_ params) | `{widget bye $who}` takes one argument | only `@` names are parameters (`parseWidgetDef`); `$who` and `_name` are none | `widgetDefinitions` |
| `diagnostics` SP302, `literal-contracts` L77 (include) | `{include ActResist}` falls back to the passage name `ActResist`, and `resolveIncludeTarget` resolved it | a bare word is an expression (SP113): only a quoted name is a target; the flag is `splitIncludeFlag` | `passageTarget`, `splitIncludeFlag` |
| `diagnostics` SP200/SP203 (#62) | `$missingProse` in prose and `$missingLiteral` in a string are undeclared; the first usage of a name is reported | the variables the code reads are validated (`variableReferences`); prose and strings are text; every reference is reported | `validateVariableReferences` |
| `diagnostics` SP201 | `$name.length` on a string is rejected; the range is the field | members of a primitive's wrapper are allowed; the range is the whole reference (`$name.nope`) | `validateVariableReferences` |
| `diagnostics` SP108 (`{else "extra"}`) | the LSP's schema rejects arguments of `{else}` | the runtime ignores them; SP108 is for configured macros (`ban`) | `validateStoryMarkup` |
| `markup-contexts` L1-passages | `[[open` and `{if $x` in a passage are text | each is never closed: SP105 twice | `tokenizeMarkupTolerant` |
| `code-actions` #62 | `It costs $5.` declares `$5` | `$5` in prose is text; `{print $5}` is a variable | `variableReferences` |
| `cli` "#63 HTML attributes", `diagnostics-attribute-blocks` | SP103 warned that a macro or a non-sigil expression in an attribute value is output as text | the value holds markup and Spindle evaluates both: no diagnostic. Errors in it are reported like any other, naming the attribute. `diagnostics-attribute-markup` replaces the file | `passagePieces` (`text` pieces) |
| `cli` "another format" | `<</if>>` is a stray closing tag (SP102) | it is text; the fixture uses a stray `</b>` | `tokenizeMarkupTolerant` |
| `runtime-pitfalls.tw` | `{include ActResist}` | `{include "ActResist"}` | `passageTarget` |
| integration `lsp` "SP110" cross-file tests | `{goto "PageTwo"}` with the LSP's `passage` schema reports SP110 for a passage that does not exist | SP300 (`unknown-passage`) does; the tests probe it and no longer register a schema for `{goto}` | `validateStoryMarkup` |
| `test/helpers/story-variables-oracle.ts` `validatePassages` | threw "needs upstream API" | `validateVariableReferences` (0.59.25). `executable-refs` and `field-access-runtime` now run against it | `validateVariableReferences` |

Tests deleted (each with the code it tested):

- `attribute-blocks`, `attribute-blocks-runtime`, `diagnostics-attribute-blocks`:
  `findUnevaluatedBlocks`, `conditionalExpression`, `printExpression`
  (`attribute-blocks.ts`) and SP103, whose premise is gone (above).
- `widget-arguments`: `splitWidgetArguments` mirrored the runtime's `splitArgs`.
- `diagnostics`: the `resolveIncludeTarget` cases (replaced by `passageTarget`
  and `splitIncludeFlag`, covered by SP302 and L77); the four `parseMacros`
  robustness cases (a mirror; the same inputs go through `computeDiagnostics`).
- `do-body`: D-mask (`maskRawDoBodies`), the per-release D-before/D-after cases
  (replaced by D-body/D-syntax), `INSTALLED_CAPABILITIES`.
- `markup-differential`: the D3 `ours` vs `tokenize` cases and the fuzz, the D1
  `parseMacros` comparison and C-D1-quote "the macro in the label is a macro"
  (they compared `parseMacros`, `attributeValueSpans` and `findBracketLinks`,
  mirrors that go away). D3-refs, D1-refs, the variable reads and the quote
  cases stay.
- `element-macro-differential`: "the shared pairing against pairMarkup" (compared
  `parseDocumentMacros`); the folding case now compares with `pairMarkup`'s own
  pairs (recovered ones included).
- `parameter-validator`, `argument-lexer`: `argCountRange` and `countArguments`
  (no consumer).
- `diagnostic-codes`: SP103.

Matrix cells: `C/include-widget-other-bare/*` and `-flag-before/*` pass (the bare
word is an expression: no reference, no SP302). Three cells still fail for the
widget registry, which this scope does not own: `B/ordinary/widget-in-comment`
[macro-oracle] (a `{wid}` in a closed HTML comment is a reference),
`B/ordinary/widget-in-attr` [macro-oracle] and [rename] (a `{wid}` in an
attribute value is not renamed, so SP100 appears). `C/sigil-transient/var`
[rename] fails on a new diagnostic: renaming `%tr` to `5` writes `{set %5 = 1}`,
which does not parse (`%5` is a modulo in code); Spindle reports SP106. Rename
should reject a digit-leading name for a `%` variable (a digit-leading `$`
name is a valid identifier); the property's comment calls `%5` "valid in code".

Needs upstream API (W2a):

1. `validateStoryMarkup`/`validateMarkup` check nothing else of a passage with
   a malformed tag (the first `MarkupError` of `parseMarkup` ends it). An editor
   wants unknown macros, passage names and code errors alongside, as
   `passagePieces` and `collectStoryPassageReferences` already read half-typed
   markup. Wanted: a `tolerant` option that goes on (and reports every tag
   error, as `tokenizeMarkupTolerant`/`pairMarkup` do), so that `wellFormed()`
   (a copy with the malformed tags blanked) can go.
2. `parseWidgetDef` keeps the comma in `@a,` (`{widget "x" @a, @b}` has the
   parameters `@a,` and `@b`); the count is right, the name is not.

The shared layer lacks `storeVar` in `MacroRegistry.toolingMacros()` (and so in
`MarkupContext.macros`): `variableReferences` and `validateVariableReferences`
need it for the input macros, so diagnostics adds it from the registry.

## Cleanup: tracker validation mirror

`computeDiagnostics` takes SP200, SP201 and SP203 from the runtime's
`validateVariableReferences`, so the variable tracker no longer mirrors the
story start's validation. Deleted from `variable-tracker.ts`: `getUndeclared`,
`getUndeclaredTransient`, `getPrimitiveFieldAccesses` (+ `PrimitiveFieldAccess`),
`getNullDeclarations`, `getNullTransientDeclarations` (+ `NullDeclaration`),
the `undeclared()` helper, the per-declaration `schemas` map and the
`validated`/`indexed` flags of a usage (a `StoryScript` passage is now skipped
when usages are recorded, which is what `indexed` did); `variable-schema.ts`
(`findPrimitiveFieldAccess`, a copy of the runtime's `validateRef`);
`VariableReference.validated` in `executable-refs.ts`; the unused `_macros` and
`_storeVarMacros` parameters of `scanDocument` (`scanDocument(uri, text, markup?)`
now). Kept: declarations with spans, usages with ranges and paths (rename,
references, hover, semantic tokens, inlay hints), `getArrayMemberAccesses`
(SP206), the invalid-declaration lists (SP207).

Tests deleted or ported (the end-to-end cover is `diagnostics-variables.test.ts`,
new: every case that went through the tracker's `getUndeclared`,
`getUndeclaredTransient` or `getPrimitiveFieldAccesses` now goes through
`computeDiagnostics` with the range of the reference):

| Test | What happened | Reason |
| `variable-schema.test.ts` (whole file) | deleted | `findPrimitiveFieldAccess` is gone; SP201 against the runtime is `field-access-runtime` and `executable-refs` "SP201 matches the runtime" (both now through `computeDiagnostics`) |
| `variable-tracker.test.ts` "detects undeclared variables" | deleted | `diagnostics.test` "produces SP200" |
| same, "reports these references when undeclared ... (#62)" | ported | `diagnostics-variables` (StoryInit, template, label, receiver, transients) and `diagnostics.test` #62 |
| same, "accepts any field of a null default", "declares a null default" (the `getNull*` lines), "does not flag non-null values as null declarations" | the `getNull*` assertions and the last test deleted, the null-field case ported | the methods returned `[]` always; "accepts any field of a null default" is in `diagnostics-variables` |
| same, "skips passages tagged script or stylesheet" | the `getUndeclared` line replaced by `getUsages('real')`; no-SP200 case ported | `diagnostics-variables` "passage the story does not render" |
| same, the describe "undeclared references as Spindle validates them (#62)" | ported (every case) | `diagnostics-variables` "SP200 for what a passage executes" |
| same, `undeclaredNames` lines of "string literals in prose and code" and "CSS-prefixed variable displays (#58)" | the validation line removed, the usage lines stay | ported to `diagnostics-variables`; `diagnostics.test` #58 |
| same, the describe "field access on primitives (Spindle validateRef)" | ported (every case, with the range of the whole reference as the tooling API reports it) | `diagnostics-variables` "SP201" |
| same, "references the tooling API reads" | `names()` returns the usages only; the `undeclared` halves ported | `diagnostics-variables` |
| same, "keeps the StoryScript text out of the usages, but validates it like Spindle" | the usage half stays; the validation half ported (`a` and `b` are both undeclared) | `diagnostics-variables` "StoryScript" |
| `executable-refs.test.ts` "agrees with validatePassages on every fragment and on random passages" | deleted | it compared the tracker's `validated` references (= `variableReferences`) with the runtime; the same fragments and random passages are compared by the SP200 differential below |
| same, "reports the offset of each reference `$`" | kept, over every reference found | no `validated` filter |
| same, "SP201 matches the runtime", "SP200 follows the installed Spindle" | helper changed to `computeDiagnostics` | the tracker no longer reports them |
| `field-access-runtime.test.ts` | `lspErrors` goes through `computeDiagnostics` (SP201 messages); no case deleted; the upstream-defect test (spindle#466) is unchanged and still fails | |
| `link-interpolation.test.ts` Q-validation | `lspUndeclared` goes through `computeDiagnostics` | |
| `macro-discovery.test.ts` "records the variables of an expression parameter" | `getUndeclared` replaced by the SP200 messages of `computeDiagnostics` | |

Dead code removed (checked with `npx fallow dead-code` and grep over `src` and `test`):

- `passageMacroHeads`, `passageRefs`, `quoteArg`, `readLinkMacro`,
  `NON_MARKUP_PASSAGES`, `isSpindleFormatName`, `readStoryDataFormatVersion`:
  no longer exported (used inside their module only).
- `passage-parser.ts`: `HAS_PASSAGE_HEADER`, `PassageBody`, `passageBodies` (+ the
  line counter), `isSpecialPassage`, `maskNonMarkupPassages` (its only caller was
  the test "L2-masking" of `markup-contexts`, deleted with it: no consumer masks
  passages any more; the rest of L2 covers what a non-markup passage holds).
- `markup-symbols.ts`: its copies of `markupTokens` and `macroTokens` (importers
  use `core/markup/tokens.ts`); `references.ts` `isTransientAt`; `MarkupIndex.remove`;
  `DocumentMarkup.passageAtOffset`; `MacroNode` (`types.ts`); `parseLinks` and
  `LinkRef` (`link-parser.ts`); `isPrettierAvailable`; `scanSpindleTokens`
  (`scanSpindleMarkup(text).tokens`; the three test files keep a one-line helper);
  `decodeStringLiteralBody` and `JsQuote` (`js-string-literal.ts`, deprecated and
  no longer used by diagnostics); the `escapes` parameter of `bracketLinkMismatch`;
  unused imports and locals.
- Tests for them: `link-parser.test.ts` keeps all its cases, reading the bracket
  links through `documentPassageRefs` (covered with the other forms by
  `passage-refs.test.ts`); `passage-parser.test.ts` "isSpecialPassage" (the set is
  exercised by the reserved-name tests of rename) and `prettier-bridge.test.ts`
  "isPrettierAvailable" deleted; `literal-contracts.test.ts` "the remaining decoder
  agrees with passageTarget" now states the expected values of `passageTarget`
  (same inputs), the decoder assertions in "treats malformed or legacy escapes as
  undecidable" were redundant with the `passageTarget` ones next to them.
- Kept although `fallow` reports them: `MarkupCursor.enclosingMacro`,
  `headBeingTyped`, `linkTarget` (called by signature help and completions) and the
  `triggerChar` parameter of `getCompletions` (the review harness passes it).

## Variable references: the `all` option (Spindle 0.59.27)

- `collectVariableReferences` (`executable-refs.ts`) is now one call,
  `variableReferences(content, macros, { all: true })`, which also returns the
  receiver of `{unset $x}` / `{computed $x = ...}` and the `{$name}` of link, display
  and expression selectors. Deleted: `selectorReferences`, `receiverReference`,
  `macroNamed` and its table, `SCOPE_SIGILS`, and the `lexJs` / token scan behind them
  (about 85 lines). Nothing needs the checked subset on its own: diagnostics use
  `validateVariableReferences`, so there is no `validated` distinction.
- No cell or test changed; rename, references and code lens of such references stay
  covered by the existing rename / references / link-interpolation / variable-tracker
  tests and the matrix (5209/5209).
- `markup-symbols.ts` keeps its `lexJs` pass over code pieces: hover and semantic
  tokens also name the `_` and `@` locals, which `variableReferences` never returns
  (they are not variables), so it cannot be replaced by it.
