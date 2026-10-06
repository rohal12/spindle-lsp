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

Peer range: verified and narrowed to `>=0.43.0`, with version-gated SP200/SP201
and an SP001 diagnostic below the floor (see the "Result" section of
[2026-10-06-peer-range.md](2026-10-06-peer-range.md)). The earlier
`>=0.34.0` was never supportable: Spindle before 0.43.0 has no transients, so
the range is a ledger decision, recorded here and in `package.json`.

Known gaps: keywords are tokenized only in macro arguments, including `${}`
interpolations (string/template text excluded). Spindle 0.45.1 has no keyword
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

## SP202 closure (branch `fix/close-m-sp202`)

Runtime oracle: Spindle 0.45.1 `src/index.tsx` throws "Missing StoryVariables
passage" at startup, so a Spindle story without one cannot start.

- **Ownerless declared story: not reachable.** The story format is read from
  StoryData *passages*; a document with a StoryData passage holds a passage and
  so is an owner. Empty or passage-less documents (and JS/TS sources) declare
  nothing, so there is no story to start, no SP202 and no fix needed (no
  create-file edit applies). Controls: `M-SP202-control` (two tests),
  `M-SP202-never-ownerless`, CLI `C-M-SP202-empty` (exit 0).
- **Owner/extension defect (fixed).** The H78 owner was restricted to
  `.tw`/`.twee`, but the workspace indexes, diagnoses and publishes for every
  non-JS/TS document (an unsaved `untitled:` buffer, `.tw2`, ...). A declared
  story whose StoryData lived there got no SP202 and no fix (previously the
  diagnostic itself had no extension filter; the restriction was added with the
  quickfix). `missingStoryVariablesOwner` now uses the workspace definition.
  Tests: `M-SP202-uri` (5), CLI `C-M-SP202` (exit 1), LSP codeAction round trip
  on `untitled:`.
- **Header-only CRLF (fixed).** SP200/SP202/SP203 insertions detect the line
  ending from the document, else the first other story document, else LF
  (`M-EOL-*`).
- **Closing completion end to end.** `lsp.test.ts` requests
  `textDocument/completion` after `{/i` through the spawned server, applies the
  `textEdit` and expects `{/if}`.

Red evidence (new tests overlaid on old source via detached worktrees; no stash):

| Base | Result |
| --- | --- |
| `11573c1` (pre-convergence), `convergence-edits`, `diagnostics-contracts`, `navigation-contracts` | 69 fail, 26 pass; every pass is a `C-*` control, a before-scan/boundary control, or a Q68/Q69/E75 case where the old behavior was already correct (JS/TS sources never hold passages, config opened after the story, newline-terminated declarations) |
| `7478fbe` (before the gap fixes) + old owner function | H78-first, H78-empty-first, H78-multi, H78-unsaved fail; H78-config-first and H78-crlf pass (controls for behavior that was already right); G74 (4 tests) fail |
| `7478fbe`, new M tests | `M-SP202-uri` (untitled, .tw2, .md) and 3 `M-EOL` fail |

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

## Markup contexts: links, passage roles, attributes, crossing (branch `fix/close-l-refs`)

Spindle 0.45.1 tokenizer, `interpolate()` and `buildAST` are the oracles
(`test/unit/markup-differential.test.ts`, `markup-contexts.test.ts`,
`macro-pairing-runtime.test.ts`; LF and CRLF). Normal gate: 66 files / 1,587
tests (base 63 / 1,422); `npm run typecheck` clean.

| Contract | Result |
| --- | --- |
| L1 macro-looking bracket-link labels | Passage references already followed the link token (control tests added). Variable usage did not: `linkInterpolationRanges()` now limits a link's executable text to the `{$x}`-style blocks `interpolate()` reads (display, target, selectors); everything else in a link is text. Startup validation of raw `$x` is unchanged. |
| L2 passage-role masking | `maskNonMarkupPassages()` / `isMarkupPassage()` in `passage-parser.ts` are the one role mask: diagnostics, `parseDocumentPassageRefs`, closer pairing (`macroHeadNames`), document links, completions, folding, inlay hints, semantic tokens, widget invocations and variable usage. Passage headers are also boundaries: no macro or link spans one (`passageBodies()`). |
| L3 `attributeValueSpans` | Differential against `tokenize()` found the scan stopped at unclosed links, failed tags and version-dependent constructs, and `parseMacros` let a `[[` inside an attribute value start a link. `scanHtmlTags(text, 'installed')` follows 0.45.1 for what versions disagree on, with a linear work budget; `conservative` (SP102) still stops there. |
| L4 crossed containers | `pairMacros` blames the closer `buildAST` rejects (`{wrap}{if}{/wrap}{/if}`: `{/wrap}`), pairs `{if}`/`{/if}`, keeps the crossed closer with its widget for rename, and SP101 reports Spindle's "expected {/if} but found {/wrap}". Missing closers (`{if}{for}{/if}`) still pair the closer with its opener. |

Observed, not changed: Spindle's link macro reads `"display" "target"` with a
quote regex, so a label containing `"` navigates elsewhere at runtime
(`[[{goto "X"}->Target]]` goes to `}`); references follow the link token
(control `C-D1-quote`). Macro heads whose names contain other characters
(`{a=b}`) are macros to the tokenizer but not to the macro grammar.
HTML elements are not on the pairing stack (SP102 replays them).

## Observed items closed: link quotes, macro heads, element/macro stack, fixture provenance (branch `fix/close-p-observed`)

Spindle 0.45.1 installed; the same suite was run through `scripts/peer-matrix.sh` on 0.43.0,
0.45.1, 0.50.0, 0.50.1, 0.51.0, 0.51.1 and 0.51.3 (see the table at the end). Normal gate:
`npm test` 75 files / 1,825 tests (base 71 / 1,768; +57 new tests in 4 new files, no
existing test removed; the existing expectations that changed are listed per item); `npm run typecheck` clean.

### 1. Link-label quotes: fixed (SP304), a Spindle bug fixed in 0.51.1

Reproduced against the real runtime: tokenize, then `buildAST` (which renders every
bracket link as `{link "display" "target"}`), then the installed component's own
`parseArgs`, cut out of `MacroLink.tsx` by `test/helpers/link-macro-oracle.ts`. The earlier
control `C-D1-quote` copied the regex by hand; the new oracle runs the installed source.

| Source | 0.45.1 (and every release before 0.51.1) | 0.51.1 and later |
| --- | --- | --- |
| `[[He said "hi"->T]]` | label `He said `, navigates nowhere (passage `""`) | reads back as written |
| `[[{goto "X"}->Target]]` | label `{goto `, navigates to `}` | reads back |
| `[[Go->a"b]]` | navigates to `a` | reads back |
| two-line label `[[a<LF>b->T]]` | navigates nowhere (`.` does not match a line break) | reads back |
| `{link "say \"hi\"" "T"}` | no escapes: label `say \`, passage `""` | `\"`, `\'`, `\\` decoded |
| `{link "a\nb" "T"}` | label `a\nb` (backslash, n) | same: only quotes and backslashes are decoded |

The release boundary is 0.51.1 (0.51.0 has the regex `/(["'])(.*?)\1/g`; 0.51.1 builds the arguments with
`quoteArg` and reads them with an escape-aware regex); checked on the packed 0.43.0 to 0.51.3 sources.
Not a defect to ignore: the link navigates somewhere other than the source says, with no error.

- New diagnostic **SP304** (`LinkRuntimeMismatch`, warning), message names the runtime reading
  ("Spindle 0.45.1 reads this link differently from how it is written: the link macro reads
  the label as "He said " and a click navigates nowhere, not to "T". ... update Spindle to
  0.51.1 or later"), range = the whole `[[...]]` or `{link ...}` tag, masked passages and
  attribute values excluded. Gated by the new capability `linkQuoteEscapes` (>= 0.51.1);
  without a detectable version the 0.45.1 behavior applies (`link-runtime.ts` is the port).
- `{link "x" "T"}` string targets (references, definition, rename, document links) follow the
  runtime reading: before 0.51.1 verbatim, from 0.51.1 with `\"`, `\'`, `\\` decoded;
  rename encodes the new name for the version (escapes from 0.51.1, rejected before 0.51.1 when
  the quote, a line break or a backslash cannot be written). A `{$x}` in a link string is
  literal text at runtime (the link macro never interpolates its arguments), so it is the
  name, no longer skipped as dynamic.
- Bracket-link targets stay the written target for definition, references and document
  links (that is what rename must edit); SP304 names where the click goes instead. Rename to
  a name with `"` or a line break is rejected for a `[[link]]` before 0.51.1 (`RenameError`
  with the position), accepted from 0.51.1.
- Differential `P1-bracket`: 3 forms x 584 labels x 7 targets (over 12,000 links incl. LF/CRLF
  breaks) against the real `parseArgs`: SP304 fires exactly when the runtime reading differs
  (0 times on 0.51.x). `P1-macro` does the same for `{link}` strings.
- Tests: `test/unit/link-runtime.test.ts` (26). Adjusted: `literal-contracts.test.ts`
  `X70-script-rename-quote`, `R67-bracket-multifile` (renamed to `Bob's`, valid in every
  version), `R67-link-macro`, `R67-reject-link-macro` (installed-version dependent).

Observed while doing this, not part of the item: Spindle's `link` macro does not interpolate
`{$x}` in its label or passage (`ctx.resolve` is only applied to `className`/`id` in
`define-macro.ts`, and `Button`/`Dialog` labels): `[[Take {$item}->T]]` shows the braces
literally in 0.45.1 and 0.51.3. Variable usage inside links is still reported as startup
validation reads it; no label diagnostic exists for this yet.

### 2. Macro heads: fixed

The tokenizer takes the text between the braces whole: the name is everything up to the first
whitespace (after `/` for a closer, which accepts any text, also none; after the selectors
and one space for an opener, which starts with a letter). `{a=b}`, `{if($x)}`, `{x{$y}}`,
`{/.cls if}` are macros named `a=b`, `if($x)`, `x{$y}`, `.cls`; `{/}` and `{/ x}` close a
macro named ``. `macroHeadRegex` now matches only the brace and the selectors; the name,
arguments and close are read from the balanced brace (`parseMacrosInPassage`), so the one
grammar behind `parseMacros`, `macroHeadNames`/`macroHeadNameAt`, references, rename,
definition, diagnostics, folding, completions and semantic tokens agrees with the tokenizer.

- Differential `macro-head-differential.test.ts` (12): 60,000 random heads against the
  installed tokenizer, 60,000 with quotes/backticks and 30,000 mixed fragments against the
  vendored 0.51.3 tokenizer, comparing start, name and closer flag. All three fail on the
  old head grammar. Consumers: SP100 names the whole macro (`{a=b}`), SP104 reports a
  closer of any macro that is no container (also unknown names and `{/ x}`; Spindle throws
  at every such closer), a widget `{widget "a=b"}` has references, definition and rename.
- Found through it, **`{do}` bodies** (version dependent, now handled): from 0.50.1 the
  tokenizer keeps a `{do}` body as raw text up to the first `{/do}` (capability
  `rawDoBodies`; masked by `maskRawDoBodies` in diagnostics, pairing, folding, heads,
  completions, tokens), so an object literal `{name: "x"}` is no macro. Before 0.50.1 it
  is a macro, and `{do}` runs `collectText(children)`, which drops it: the installed 0.45.1
  turns `Story.defineMacro({name: "x", ...})` into `Story.defineMacro();`. SP100 on it
  now says so. Tests `do-body.test.ts` (10).
- Adjusted: `macro-parser.test.ts` (`{/.cls if}` is a closer named `.cls`, `{a: 1}` after an
  unclosed macro is the macro `a:`); StoryInit discovery tests and the CLI test wrote
  `{name:` in a `{do}`, which 0.45.1 drops, so they use `{ name:` now.

### 3. HTML elements and macro blocks: divergences found and fixed

`element-macro-differential.test.ts` (9 tests) runs every sequence of up to 5 of `<div>`,
`</div>`, `{if}`, `{/if}`, `{wrap}`, `{/wrap}` (a block widget) and every sequence of up to 4
of eight symbols with two element names, LF and CRLF, through the installed `tokenize` +
`buildAST` and each consumer: diagnostics (SP101/SP102/SP104 absent when `buildAST`
accepts, one at the failing token otherwise), folding (the pairs `buildAST` makes, up to
its first error), widget heads (references, definition, rename) and the shared pairing.

On the old source: references, definition and rename already agreed (the heads test passed);
**pairing, folding and diagnostics diverged** and are fixed:
- `pairMacros` ignored elements: `{wrap}<div>{/wrap}</div>` paired `{wrap}`/`{/wrap}` (and
  folded it) although `buildAST` throws at `{/wrap}`; SP102 replayed the stack separately and
  stopped at any unpaired container, so `{if}<div>` reported no unclosed `<div>`.
- Fix: elements are events on the one stack (`collectElementEvents`, `pairMacros(...,
  elements)`, `parseDocumentStructure`); the closer `buildAST` rejects stays unpaired
  (`expectedElement`, kept by rename as a closer of an open container), the SP102 findings
  come from the same simulation (`replayElements` is gone), `macro.element` replaces its
  map, and the reading still stops where the scanner is uncertain (`stop` event). The
  documented recovery for missing closers (`{if}{for}{/if}`) is unchanged and applies to
  elements.
- Behavior changes: a crossed closer over an element reports SP102 at the closer and SP101
  "no matching" on the container it leaves open (as crossed macros already did); a closing
  tag after an unclosed `{if}` is now SP102 `expected {/if} but found </i>` (was suppressed).
  Adjusted tests: `diagnostics-containers` (1), `diagnostics-malformed-element` (2).

### 4. Fixture provenance

`test/fixtures/spindle-0.51.3/README.md`: origin package and version, Unlicense, which files
are byte-identical (`tokenizer.ts`) and which changed (`story-variables.ts`: header and
two import lines), why they exist, and how to refresh them.

### Verification

| Run | Result |
| --- | --- |
| `npm test` (0.45.1) | 75 files, 1,825 passed |
| `npm run typecheck` | exit 0 |
| New tests on the old source (overlay on a detached worktree of the base) | 25 of 50 in the five affected files fail: `link-runtime` (file fails to load), element differential diagnostics/folding/pairing, all macro-head differentials, `do-body` D-before/after/outside/mask, capability tests |
| `scripts/peer-matrix.sh` 0.43.0 / 0.45.1 / 0.50.0 | 1,813 / 1,825, tsc 0 |
| 0.50.1 / 0.51.0 / 0.51.1 / 0.51.3 | 1,806 / 1,825, tsc 0 |

The matrix failures are not new: 12 tests need the built `dist/` (bin, format entrypoints,
absent in the peer-matrix copy) and, from 0.50.1, 7 older oracle comparisons against the
installed tokenizer (`placeholders-oracle`, D3-fuzz) that disagree about braces inside
strings. The base commit has the identical 19 failures on 0.51.3 (1,749 / 1,768) and the
failing test names match.


## Link interpolation and brace reading: runtime truth per version (branch `fix/close-q-versions`)

Two contracts, both settled against the published runtime rather than against another
consumer. Verification and the version x pass table are in
[2026-10-06-peer-range.md](2026-10-06-peer-range.md) (section "Every release green").

### 1. What Spindle interpolates in a link: the contradiction, resolved

The claim "the `link` macro does not interpolate `{$x}` in a label or passage" (found by one
agent) and `linkInterpolationRanges()` treating `{$x}` in a label, target and selectors as
executable (added by another) cannot both hold. The runtime decides.

**Evidence.** `scripts/runtime-render.mjs <version> [markup]` installs a published release plus
jsdom, bundles its own `tokenize` -> `buildAST` -> `renderNodes` with the builtin macros and prints
the HTML (variables `item = "Sword"`, `n = 3`). Twelve cases on all 22 releases from 0.43.0 to
0.51.3 and on 0.42.0 for the record: **identical output on every one of the 23 releases**, so no
capability gate is needed.

| Markup | Rendered |
| --- | --- |
| `[[Take {$item}->T]]`, `[[Take {$item}]]` | `<a class="macro-link">Take {$item}</a>` |
| `[[Go->T{$n}]]`, `[[Take\|T{$n}]]` | `<a ...>Go</a>`, `<a ...>Take</a>` (the target is the literal name `T{$n}`) |
| `[[.c{$item} Go->T]]` | `class="macro-link cSword"` (selectors **are** interpolated) |
| `{link "Take {$item}" "T"}` | `Take {$item}` |
| `{button "Take {$item}"}`, `{dialog "Open {$item}"}` | `Take Sword`, `Open Sword` (the label **is** interpolated) |
| `{print "a {$item}"}`, `{set _s = "a {$item}"}{_s}` | `a {$item}` (a string is a string) |
| ``{print `a ${$item}`}`` | `a Sword` (template code is JavaScript) |
| `<a title="{$item}">` | `title="Sword"` (attribute values are interpolated) |

**Why**, from the source (all releases): the tokenizer reads a link as one token; `buildAST` turns
it into the `link` macro with `rawArgs` = the quoted display and target and `className`/`id` from
the selectors; the macro wrapper (`define-macro.ts`) resolves `className` and `id` through
`interpolate()` when the macro is defined with `interpolate: true`; `MacroLink` itself never calls
`ctx.resolve` and prints/navigates to the strings `parseArgs` returns. Across all releases the only
components calling `ctx.resolve` are `Button` and `Dialog` (label), `If` and `Timed` (section
selectors). `render.tsx` resolves HTML attribute values.

So the second agent's `linkInterpolationRanges()` was wrong about display and target, and
`blankLiteralText()` (keep `{$x}` in every macro string) was wrong for every macro but `{button}`
and `{dialog}`.

**Consumers, now in agreement** (`link-interpolation.test.ts`, 124 tests, LF and CRLF; `scripts/runtime-render.mjs` is the render evidence and is not part of `npm test`, it needs the network):

| Consumer | Before | Now |
| --- | --- | --- |
| Usages (references, rename, code lens) | `{$x}` in link display/target and in every macro string | Link selectors, `{button}`/`{dialog}` labels, attributes, code. Built-in macros that take JavaScript (`LITERAL_ARGUMENT_MACROS`, 39 names, checked against the installed registry) keep no block in their strings; a macro of the project's own may interpolate, so its strings still do |
| SP200/SP201 (startup validation) | unchanged | unchanged: raw text before 0.50.1 (a `{$x}` in a label is flagged), tokenizer-based from it (link tokens validate nothing); compared with the installed `validatePassages` on 9 fixtures |
| `linkInterpolationRanges()` | display, target, selectors | `linkSelectorInterpolationRanges()`: selectors only |
| New diagnostic **SP305** (`LiteralLinkInterpolation`, warning) | none | one per `{$x}`/`{_x}`/`{@x}`/`{%x}` block in the display or target of a bracket link and in the first two strings of `{link}`; message says the text is printed/navigated to as written and names `{button "…"}{goto "…"}{/button}`; same on every release, so ungated; the brace end follows `stringAwareBraces` |

SP305 deliberately stays on links. Other macro strings print braces literally too, but a macro the
project defines may interpolate its arguments, so flagging them would be a guess; the usage rule
above is the same boundary.

Existing tests that encoded the wrong rule were corrected, not weakened: `D1` (markup-differential)
and `L1` (markup-contexts) now model the runtime (selectors read, display/target literal);
`#44` string-interpolation tests use `{button}` for the positive case.

**Rename.** `Q-rename-edits/-reparse/-lens` rename `$x` with `computeRename`, apply the edits with
`TextDocument.applyEdits`, rebuild the workspace and re-read with the runtime tokenizer: the
selector, the `{button}` label, the attribute and the `{print $x}` code change; the link text, the
`{link}` string and `{print "{$x}"}` do not, and the interpolated reads of `y` equal those of `x`
before.

### 2. The tokenizer's brace reading changed in 0.50.1: made version-aware

Cause of the 7 oracle failures on >= 0.50.1: the tokenizer (byte-identical in 0.43.0 to 0.50.0,
byte-identical in 0.50.1 to 0.51.3) counts every brace before 0.50.1 and skips string and template
literals from it (`scanBalancedBrace`; also in attribute values and in `interpolate()`).

New capability `stringAwareBraces` (>= 0.50.1) in `SpindleCapabilities`. Followed by:

- **Formatter** (`scanSpindleTokens`, `replaceSpindleTokens`, `FormatOptions.stringAwareBraces`): the
  LSP passes the workspace's capabilities per request, the CLI and the MCP tools resolve the target
  with `findSpindleCapabilities` (installed `@rohal12/spindle` at or above the files, else StoryData
  `format-version`, else the 0.45.1 behavior).
- **Markup parser** (`BraceReading`): `createCodeScanner`, `parseMacros`, `findBracketLinks`,
  `attributeValueSpans`, `parseLinks`, `scanHtmlTags` (new `modern` policy beside `installed`),
  the variable tracker and signature help take the reading; omitted means 0.45.1. Before, the
  parser read braces as 0.50.1 does on every release, so on 0.45.1 `{set $x = "}"}` was one macro
  where the runtime sees `{set $x = "}` and text. **Behavior change on < 0.50.1**, verified against
  that tokenizer (60,000 random heads with quotes, `H-installed-quotes`; the D3 fuzz of links,
  tags and attribute values with no case excluded).
- Oracle tests use the installed tokenizer with the matching reading
  (`placeholders-oracle`, `markup-differential`, `macro-head-differential`); the tests that fixed
  the unknown-version behavior (`diagnostics-containers`, `diagnostics-malformed-element`,
  `diagnostics-attribute-blocks`, `signature`, `macro-parser`) now state both readings, force the
  release with a StoryData `format-version`, and compare with `buildAST` for the installed one.
- Findings from making it exact: a tag with whitespace around `=` and an unbalanced `{` in an
  attribute value were treated as "versions disagree, stop"; the tokenizer is the same for the
  first in every release (no tag, `</a>` is unexpected) and differs for the second only at 0.50.1.
  Diagnostics now report them as the target release would (`SP102 unexpected closing </a>`).

Also: `scripts/peer-matrix.sh` now copies `esbuild.config.ts`, so the 12 dist-based tests
(`bin`, `format-entrypoints`, CLI, MCP, LSP integration) run in every matrix copy;
`vitest.config.ts` has a 120 s test timeout (the differential suites time out on a loaded machine),
and the three wall-clock thresholds in `macro-parser.test.ts` are 5-10 s (quadratic behavior still
fails them by orders of magnitude).

Superseded: the "Verification" note of the previous section ("matrix failures are not new: 12 tests
need the built `dist/` ... and 7 oracle comparisons") describes the state before this branch; the
matrix is now 22 of 22 green (1,977 tests each).

### Verification

| Run | Result |
| --- | --- |
| `npm test` (0.45.1) | 77 files, 1,977 passed |
| `npm run typecheck` | exit 0 |
| `scripts/peer-matrix.sh` on all 22 releases 0.43.0-0.51.3 | 1,977 / 1,977 each, tsc 0 |
| Runtime render, 12 cases on 23 releases (0.42.0, 0.43.0-0.51.3) | identical output |
| New tests: `link-interpolation` (124), `format-brace-reading` (12) | pass on 0.45.1, 0.50.0, 0.50.1, 0.51.3 (and all others) |
| Existing tests changed | `markup-differential` D1/D3, `markup-contexts` L1, `variable-tracker`/`rename`/`variable-declarations` string-interpolation cases (`{link` -> `{button`), `diagnostics-*`, `signature`, `macro-parser`, `macro-head-differential`, `placeholders-oracle`, `spindle-capabilities` |
