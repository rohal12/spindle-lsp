# October review contract repairs

This repair starts from `874a6937affa94b35669bb2420aace750b69d331`
(`origin/main`, PR #102 merged). The initial working tree was clean. Node is
22.18.0, spindle-lsp is 0.9.0, and the installed/bundled Spindle remains
0.60.3. Issue bodies and the four reopened issues' new comments were preserved
before implementation. All twelve requested issues were open, and no open PR
already covered them. These are existing defects; no introduction claim is made.

The baseline passed `TMPDIR=/var/tmp npm test`: 2,089 unit/integration tests
in 80 files and 6,077 convergence cells in 18 shards. Typecheck passed.
`/var/tmp` avoids the documented unrelated `/tmp/.git` fixture interference.

## Ownership and closure evidence

| Owner | Repair and retained evidence |
| --- | --- |
| #13 | Rename obtains the base identifier's source end from public `lexJs`, mapped through the owning code/text piece. Cursor lookup uses the tracker's executable ranges. `VARIABLE-SPANS` applies and rebuilds renames across both sigils, escaped identifiers, property suffixes, labels, nested labels, attributes, cross-document declarations and CRLF. The framed LSP checks the originally reported declaration-initiated edit. Hover/token spans also use the lexer's source end. |
| #83 | Rename asks public `parseDeclarations` to validate the destination before returning any edits. `RENAME-COLLISION/runtime-name-*` retains reserved-name rejection, optional sigil input, `constructor`/`prototype`/`toString`, ordinary destinations and valid digit-leading story variables. LSP verifies controlled errors for `__proto__` and `$__proto__`. |
| #79 | Signature help slices decoded argument text, and inlays map decoded argument boundaries back through `TextPiece.sourceOffsets`. `CONFIGURED-ARGS/source-position-*` covers widgets and builtins, quote styles, escaped quote/whitespace, nested labels, incomplete input and attributes. Public LSP verifies signature and inlay positions under CRLF. |
| #35 | Formatter classification preserves case-sensitive compiler tag membership. `FORMAT-ROLE` compares uppercase-tagged markup with ordinary passages and retains lowercase/multi-tag controls. The old unit assertion requiring case-insensitive classification was corrected to the compiler contract; no case was removed. |
| #103 | Discovered definitions replace executable builtin metadata, including absent/false flags, empty sub-macro lists and removed constraints. Explicit project configuration still applies last, through one shared supplement helper. `MACRO-DISCOVERY/replacement-*` covers JS, TS, StoryInit, definition removal/restoration, explicit flags, markup parameters, diagnostics and applied rename. CLI/MCP/LSP verify replacement textbox/switch behavior. |
| #104 | Missing-closer diagnostic data retains the innermost owning text piece's end rather than the passage end. `QUICKFIX-CLOSER` applies every action and rebuilds across labels, nested labels, attributes, top-level controls and LF/CRLF. LSP applies the label fix and verifies the error disappears after document change. |
| #105 | Prettier resolves options using the actual document file path/URI; the path is passed through CLI, MCP and both LSP formatting requests. `PRETTIER-CONFIG` covers root JSON/YAML/package configuration, nested configuration, per-file overrides and unconfigured controls, using actual script/style/embedded output. Public entrypoints launch outside the project and verify quotes and indentation. |
| #106 | Configured passage schemas call public `passageTarget` for quoted literal values. `CONFIGURED-ARGS/passage-literal-*` checks Unicode, backslash and quote escapes, both delimiters, missing targets, labels and nested labels. Configured checks also walk nested macro tokens. Public consumers use a real discovered macro definition. |
| #107 | SP205 reads the runtime's markup tokens and code pieces with `lexJs`, excluding comments, literal strings/regex/templates and prose. Plain assignment targets remain excluded even with an intervening comment. `TEMP-LOOP` retains real display/template/expression reads and no-read contexts; historical accumulator/deferred-body controls remain in the normal gate. |
| #108 | The shared header parser permits optional whitespace after `::`; formatter segmentation follows that parser. `HEADER` retains compact, spaced, tabbed and mixed boundaries with BOM and LF/CRLF, checking indices, diagnostics, outline, navigation, applied rename and formatting. Bundled CLI detects malformed compact-header stories; LSP analyzes them too. |
| #109 | Tags are extracted from their original source slice, unescaped, trimmed and then split. Literal tag-table expectations include escaped letters, brackets, interior and edge whitespace, exact role tags and case controls. Escaped script passages preserve literal text during rename and participate in macro discovery. |
| #110 | Code lenses intentionally expose informational counts with an empty command identifier, removing the unimplemented `spindle.findReferences` action. The framed LSP checks passage, variable and widget count displays and their non-actionable commands. Reference extraction and existing count/range controls remain intact. |

The shared contract and public-entrypoint tables add **207 cells** to the
normal gate, bringing the retained matrix to 6,284. Every previous cell keeps
its identity and status: 6,271 applicable passes, 13 historical not-applicable
cells, no failures and no unrun cells. There are no new skips or expected-failure
assertions. An isolated baseline worktree running the final shared unit tables
plus tag-classification controls reproduced **97 failures / 336 passes** in
433 tests against unchanged main; passing controls are recorded separately
from added failing variants.

The two escaped-edge-space cases were additionally checked against the
installed public `@rohal12/twee-ts` `parseTwee` compiler API: both `[script\ ]`
and `[\ script]` decode to `['script']`. They failed before the decode-before-
trim refinement and pass afterwards. The comment-separated assignment control
likewise failed before its refinement and passed afterwards.

All markup/token/code/declaration/literal rules continue to come from public
Spindle tooling. No dependency update, copied parser or upstream API workaround
is introduced. Inline script regions which the runtime deliberately preserves
are still preserved; the configuration tests use supported embedded formatting
contexts.

## Review scope and verification

An independent read-only diff review checked mapping ownership, applied rename
variants, macro precedence, header roles and executable-read contexts. It found
the additional comment-separated plain-assignment control, which is retained
and repaired above. A pre-existing SP205 warning for a destructuring-only write
(`{set [_x] = [2]}`) was confirmed on both main and this branch and set aside:
full JavaScript write/data-flow analysis is outside this bounded literal-context
repair. SP205 remains the existing LSP-owned heuristic, rather than a claim of
complete read/write analysis.

Typecheck, build and all three duplication comparisons against `origin/main`
pass without raising budgets:

| Tool | Main | Repair | Duplicated lines, main → repair |
| --- | --- | --- | --- |
| jscpd | 2.49% | 2.48% | 254 → 254 |
| PMD CPD | 4.02% | 4.01% | 412 → 412 |
| fallow | 10.50% | 9.88% | 1,064 → 1,007 |

Final `TMPDIR=/var/tmp npm test` exits 0: **2,296 unit/integration tests in
80 files and 6,284 convergence cells in 18 shards pass**. The results file was
regenerated first with `REVIEW_WRITE_RESULTS=1 npm run review:convergence`, then
the ordinary gate verified the committed cell inventory without write mode.
`npm run typecheck`, `npm run build`, `git diff --check` and each duplication
tool's `--base origin/main` comparison also exit 0.
