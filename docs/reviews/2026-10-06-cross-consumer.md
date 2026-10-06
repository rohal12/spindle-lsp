# Cross-consumer matrix — 2026-10-06

Follows [2026-10-06-convergence-fixes.md](2026-10-06-convergence-fixes.md). Those
fixes closed 15 contracts (#66-#80) one consumer group at a time, by agents
working on shared code in parallel. This ledger measures what is left between
the consumers: a symbol, span or document that one consumer treats as X and
another as Y. The method is the matrix in [process.md](process.md); the retained
corpus was `test/review/convergence.review.ts` and is now sharded over `test/review/shard-*.review.ts` (+ `test/review/support/`), run by
`npm run review:convergence` and, since this change, by `npm test`.

Baseline: HEAD `161a986` (branch `fix/review-convergence`), LSP 0.9.0, Node
22.18.0, installed Spindle 0.45.1 as oracle (`tokenize`, `buildAST`,
`parseStoryVariables`, the link macro's `parseArgs`). Before: `npm test` 75 files /
1,825 tests green; `npm run review:convergence` failed with "no tests" (the file
held only helpers). After: `npm test` = unit/integration (75 files / 1,825 tests,
unchanged count) + matrix (2,606 tests), all passing; `npm run typecheck` clean.

## The matrix

Not a Cartesian product. 303 named **scenes** (fixtures) are selected from the
dimensions below; every scene runs the same cross-consumer **properties**; and
interactive cells cover completion, signature help and the entrypoints. Cell id =
`<family>/<role|spelling>/<context> [<property>]`; each cell records its six
dimensions (role, context, spelling, boundary, state, consumer) and a state in
[2026-10-06-cross-consumer-results.json](2026-10-06-cross-consumer-results.json).

| Dimension | Selected values |
| --- | --- |
| Role (9) | ordinary, widget, StoryInit, StoryInterface, StoryData, StoryVariables, StoryTransients, script, stylesheet (family A: each x 9 core contexts); plus headerless text and JS macro-source documents |
| Context (75) | bracket link (plain, pipe, arrow, reverse, two pipes, in element/attribute/comment/string arg, multiline, nested brackets, label interpolation, CSS selector), `goto`/`include`/`link` macros (double, single, template, concatenated/dynamic, bare, parenthesized, uppercase head, CSS selector head, multiline args, in `if`, in attribute/comment), variables (set/print/bare/property path/string/comment/attribute/template/temp/local/transient/prose), widgets (use, CSS suffix, in comment/string/attribute, block pair, real block widget), unknown macro, `<script>`/`<style>` contents, prose |
| Spelling (30) | two words, hyphen, unicode, astral, apostrophe, double quote, backslash, escaped `\[ \] \{ \}` header names, pipe/arrow/reverse-arrow/`]]` in names, tab, `$`/`%` in names, hyphenated/mixed-case/bare/single-quoted widgets, `$ _ @ %` sigils and adjacent sigils; quoted/bare/static/dynamic targets |
| Boundary (34) | EOF with/without newline, blank tail, LF, CRLF, mixed EOL, CRLF without final EOL, astral prefix (LF and CRLF), multiline macro, empty passage before/after, header-only EOF, U+2028, tabs and trailing spaces, BOM, tags and metadata on the header, long line, same text in two passages, incomplete brace/bracket/comment/string, text before any header, empty/whitespace-only/header-only documents |
| State (11) | multi-file, single file, config and JS source opened first, duplicate passage names, initialization order permuted, documents opened one by one, unsaved edit then revert, close then reopen, edit/close/reopen over JSON-RPC |
| Consumer | diagnostics, definition, references, prepareRename/rename (applied with `TextDocument.applyEdits`, workspace rebuilt, reparsed with the runtime), completion (textEdit applied, re-read by the runtime), signature help, hover, semantic tokens, document links, code lenses, formatting (idempotence, diagnostics, runtime payload), CLI `check`/`format`, LSP over framed JSON-RPC |

### Properties run on every scene

| Property | Cross-consumer claim |
| --- | --- |
| `[bounds]` | every range any consumer returns (diagnostics, links, lenses, tokens, references, definition, prepareRename) is inside its document with valid UTF-16 positions; prepareRename's range contains the cursor |
| `[navigation]` | for every reference any cursor position reports, every position inside it reports the same set; the symbol under a cursor is one of its own references; prepareRename's range equals the reference span where a declaration exists |
| `[passage-oracle]` | the runtime's passage targets (bracket links, `goto`, `include`, `link` strings) equal the references consumer's per document; SP300 sits exactly on the runtime references to missing passages; SP304 exactly on literals the link macro reads differently; one document link per runtime link token; code-lens counts equal the runtime reference counts |
| `[macro-oracle]` | SP100 only on runtime macro tokens; semantic tokens only inside runtime non-text tokens (`$`/`%name` may sit in prose, see below) and never in script/stylesheet/data passages; widget reference counts equal runtime head counts (closers only for block widgets) |
| `[rename]` | rename every renameable symbol (passages incl. awkward new names, variables, widgets); apply edits across documents; rebuild; diagnostics unchanged (except name-resolution diagnostics and the documented #44 leftovers); runtime payload equals the old one with the name swapped; headers and declarations renamed |
| `[format]` | idempotent; runtime payload, passage references and passage list unchanged; diagnostics unchanged |
| `[hover]` | hover appears only where semantic tokens highlight a variable/macro/widget, inside its range, including the cursor |
| `[tokens]` | sorted, non-overlapping, inside the line; `$` tokens are references to some consumer |
| `[state-order]`, `[state-incremental]` (21 scenes each) | a full snapshot (diagnostics, links, lenses, tokens, a per-position references/definition/prepareRename sweep) is identical for permuted initialization order, open-one-by-one, edit and revert, and close/reopen of each document, against a fresh build |

Interactive cells (`I/...`): completion applied through its `textEdit` and
re-read by the runtime (95: passage names x 4 boundaries x 7 prefixes, macro and
widget names, closing tags, variables and field paths, role and attribute
guards, headerless text), signature help (26: widget arguments x 4 boundaries,
role/attribute guards, agreement with runtime macro tokens at every cursor),
CLI `check` vs the in-process diagnostics and exit code (6 scenes incl. BOM and
incomplete input), LSP over JSON-RPC vs in-process diagnostics, links, lenses,
references, definition, prepareRename and rename at every interesting cursor
(5 scenes), and an edit/close/reopen sequence over JSON-RPC (1).

## Cell counts (`REVIEW_WRITE_RESULTS=1 npm run review:convergence`)

2,605 cells: **2,592 pass, 0 fail, 0 not-run, 13 not-applicable**.

| Family | Cells | | Property | Cells |
| --- | --- | --- | --- | --- |
| A role x core context | 662 | | bounds, navigation, passage-oracle, macro-oracle, rename, format, hover, tokens | 303 each |
| B contexts | 414 | | state-order, state-incremental | 21 each |
| C spellings | 556 | | I/completion | 95 |
| D boundaries | 784 | | I/signature | 26 |
| E states | 50 | | I/entry-cli, entry-lsp, entry-lsp-state | 6, 5, 1 |
| N named, not executable | 6 | | | |

Not-applicable cells (7 executable, 6 named). Each reason is in the results file:
single-document scene for the order permutation (1); hover has nothing to hover
in fixtures that contain no symbol (6); and the named cells `N/lone-cr-line-endings`
(Twee and the compiler know LF/CRLF only; the server splits at LF),
`N/cli-document-lifecycle` (the CLI reads disk once; the state differentials run
in-process and over JSON-RPC), `N/mcp-entrypoint` (same functions as the CLI,
covered by `test/integration/mcp.test.ts` and `format-entrypoints.test.ts`),
`N/spindle-version-state` (see Other versions), `N/inlay-folding-symbols-actions`
(outside the selected consumers; `inlay-hints`, `folding-range`, `document-symbol`,
`workspace-symbol`, `code-actions` unit tests) and `N/semantic-token-overlap-negotiation`
(the server never emits overlaps; the `[tokens]` property proves it).

No cell is "not run" and none is deferred.

## Defects found and fixed

Red evidence: the final corpus overlaid on the unfixed `161a986` sources (detached
worktree) fails **689 of 2,606** tests; on the fixed tree it fails 0. Counts per
defect below are cells of that red run (a cell can show more than one defect, it
is attributed to the first failure).

| # | Defect (cross-consumer) | Evidence (first failing cell) | Fix | Red cells |
| --- | --- | --- | --- | --- |
| X1 | `findReferences` fell back to "any word equal to a passage name": a cursor on prose, a header tag (`[widget]`), a string, a comment or a non-markup passage listed all references of that passage, while definition and prepareRename returned nothing; the symbol under the cursor was not in its own result | `A/ordinary/bracket-plain [navigation]`: references at `widgets.tw:0:11 ("Widgets [widget]")` | removed the fallback (`src/plugins/references.ts`) | 225 |
| X2 | Variable under the cursor was found with a raw `\$name` regex in references and rename, so `$v` in comments, strings, attributes, script/stylesheet/StoryData text got references and a rename range that did not contain the spans the tracker edits; a cursor inside `$o.a.b` after the base found nothing; `$a$b` was one name (`v$v`) although Spindle's expression transform reads `\w+` | `B/ordinary/var-in-comment [navigation]`, `B/ordinary/var-property-path [navigation]`, `C/sigil-adjacent/var [rename]` | new `variableAt` (tracker membership, whole path range, boundary preference) used by references, rename and hover; name class `\w+` in the tracker, references and tokens (one-character-class change in `variable-tracker.ts`) | with X1 |
| X3 | prepareRename/rename accepted reserved passage names (`StoryVariables`, `StoryData`, `StoryInit`, `StoryTransients`, `PassageReady`, ...) as a symbol and a new name; renaming `StoryVariables` made the story lose its declaration (SP202) | `A/ordinary/bracket-plain [rename]` first symbol swept: `rename passage:StoryVariables` | `isReservedPassageName`; rename refuses the header, references to it and a reserved new name (`rename.ts`, `passage-parser.ts`) | 279 + 13 |
| X4 | Code lens range ended after the `\r` of CRLF lines (invalid range); widget lenses came from a per-line regex in any passage or comment; variable lenses from any line `$x =` of the StoryVariables file; counts included every duplicate declaration | `D/crlf/bracket [bounds]` | lenses use the widget registry, the StoryVariables passage's lines, CRLF-aware lines and reference-only counts (`code-lens.ts`) | 17 |
| X5 | Semantic tokens highlighted `$v` in comments, strings, attribute values, script, stylesheet and StoryData text, `_t`/`@x` in prose, and everything in JS sources | `A/StoryData/bracket-in-string-arg [macro-oracle]` | `$`/`%` tokens exactly where the tracker records a reference or declaration; `_`/`@` only in the code Spindle evaluates (`executableCode`); JS and headerless documents have none (`semantic-tokens.ts`, new `executableCodeLines`) | 11 |
| X6 | Text before the first header (and documents with no header) were analysed by references/definition/rename/tokens/widget references, while diagnostics and links ignore them and the compiler drops them | `D/first-line-no-header/bracket [passage-oracle]` | the shared markup mask also masks the prelude; `WorkspaceModel.hasPassages` guards the document-level consumers (completion stays on for a new file) | 13 |
| X7 | Two passages with one name (and two widgets with one name): definition, diagnostics and widget resolution depended on the order documents were opened; references listed one header; rename left the second | `E/duplicate-passage/bracket [state-order]`, `[state-incremental]`, `[rename]` | `PassageIndex` iterates documents in URI order; `getPassages`; references include every declaration; rename renames every header | 3 |
| X8 | Completion items had no `textEdit`: a client replaces a "word", so `[[x\|Two W` + `Two Words` gave `[[x\|Two Two Words`, `{my-wi` gave `{my-my-widget`, `$s` gave `v` without its sigil; passages that `[[ ]]` cannot name (`Left\|Right`, `a->b`, quotes before 0.51.1) were offered and linked to other passages; items were offered in script, stylesheet, StoryData and StoryVariables passages and inside HTML attributes | `I/completion/passage-names/lf/partial-after-space`, `I/completion/macro-names/*/hyphen-prefix`, `I/completion/role/script/macro` | every item carries a `textEdit` over the typed prefix and following name; `[[ ]]` target span follows Spindle's `parseLink`; unlinkable names are not offered (`completions.ts`) | 75 |
| X9 | Signature help answered inside script/stylesheet/data passages and inside HTML attribute values (macros there are text, SP103) | `I/signature/role/script`, `I/signature/attribute-value` | same markup and attribute guards as completion (`signature.ts`) | 6 |
| X10 | A leading BOM hid the first header: the CLI (reading from disk) reported nothing for the file, and `format` dropped the BOM, so formatting turned an unanalysed file into one with passages | `I/entry-cli/bom-check-and-format`, `D/bom-first-header/*` | `DocumentStore` and `findStoryFormat` drop a leading BOM; `formatDocument` keeps it (`document-store.ts`, `story-format.ts`, `format.ts`) | 10 |
| X11 | Hover read raw text per line: `$v` in a comment, macros in script passages, `{wid.cls}` (a macro named `wid.cls` for the runtime) and unterminated `{goto "x` got hovers that the other consumers do not treat as symbols | `A/StoryData/goto-double [hover]` | hover uses the tracker, the executable code, and the shared macro grammar (`macroNameRange`, also used by semantic tokens) (`hover.ts`, `macro-parser.ts`) | 40 |

Evidence kept in the tree: every cell above is part of the corpus, with
`161a986` as the red baseline. Two fixes touched the variable-tracker area that
other agents are editing: the name character class (X2: `[\w$]+` to `\w+` in
`varRefRegex` and `transientRefRegex`) and two exports/accessors (`executableCode`
used by tokens/hover). The rest of the tracker and the format/placeholders
version gating were not changed.

## Checked and not defects (decisions kept, each backed by a test)

- **Rename leaves literal text.** `rename.test.ts` "leaves literal string text alone"
  (#44) and `markup-contexts.test.ts` L1 keep strings, comments and link labels
  as written. Before Spindle 0.50.1 startup validation still reads `$old` there,
  so the `[rename]` property asserts the exact consequence: the documents with
  leftover text gain one SP200, and no other diagnostic changes (`!executableRefsOnly`).
- **`$name` and `%name` in prose are references** (tracker contract
  `variable-declarations.test.ts` "still treats letter-leading transients in
  prose as before", #62; Spindle < 0.50.1 validates raw text). All consumers agree
  on this, so `[macro-oracle]` exempts only those two sigils from "inside a
  runtime non-text token".
- **Link literals the runtime reads differently** (`[[Say "hi"]]`, `{link 'a' 'Don\'t'}`
  before 0.51.1) are references to the runtime's reading and carry SP304; SP300
  is judged on the passage the author named.
- **Unlinkable passage names** are not offered after `[[` (they exist; use `goto`).
- **Completion and signature help stay on** in a document without a header (a new
  file) and while a macro is still unterminated; hover and the other navigation
  consumers do not, since the compiler drops such text and the runtime reads an
  unterminated macro head as text.

## Other versions

The same corpus was run against packed releases, with the repository's
`scripts/peer-matrix.sh` layout and `vitest.review.config.ts` (the committed
results file lists identical states, so the retained-results test is part of
each run):

| Spindle | Tests passed |
| --- | --- |
| 0.43.0 | 2606 / 2606 |
| 0.50.1 | 2606 / 2606 |
| 0.51.3 | 2606 / 2606 |

## Residual risk (explicit, bounded)

- The oracle is the installed runtime; behaviours that only exist in a Spindle
  newer than the one installed are exercised through the capability flags and the
  peer runs above, not by new oracles.
- Selected cells are a sample. A new defect class found elsewhere must extend a
  family table (context, spelling, boundary, role, state) and keep its cells in
  this corpus; the properties then run it against every consumer.
