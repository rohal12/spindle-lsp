# Formatting / entrypoint closure (#66) — 2026-10-06

Spindle 0.45.1. Extends the #66 contract in
[2026-10-06-convergence-fixes.md](2026-10-06-convergence-fixes.md); that
ledger is unchanged.

| Item | Disposition | Evidence |
| --- | --- | --- |
| Token scan vs. runtime tokenizer | Fixed (divergences) / proven not a defect (strings) | `test/unit/placeholders-oracle.test.ts`: 65 fixtures + 6,000 seeded random inputs compared span-for-span with `node_modules/@rohal12/spindle/src/markup/tokenizer.ts`. The runtime also counts braces and ignores string contents, so a stray `{` in a string extends the macro to the next balanced `}` there too; protecting that span is correct (`K66-scan` stray-brace test and control). The old scanner did diverge on 11 other fixtures: bare sigils (`{$}`), `{/}`, CSS-selector validity (`{.a}`, `{.a  x}`, `{.123 x}`), nested `[[`. |
| Multiline payloads outside HTML | Fixed (found while closing the above) | Indentation, trailing-space trimming, region segmentation (HTML/script/svg-looking lines inside a template) and container detection rewrote or misread multiline tokens in Markdown regions. Multiline tokens are now joined onto one line during formatting (`protectMultilineTokens`). `K66-payload` x LF/CRLF, 11 cases each. |
| CRLF to LF | Fixed | Compare payloads after the compiler's CRLF normalization (this file's process rule), but a formatter must not rewrite line endings: output keeps the dominant style (tie: the first). `K66-eol`. |
| CLI / MCP / LSP entrypoints | Fixed (now covered) | `test/integration/format-entrypoints.test.ts`: built executable; `format`/`--check`, `spindle_format`/`spindle_format_check` through an MCP SDK client, `textDocument/formatting` and `rangeFormatting` over framed JSON-RPC; LF and CRLF. |
| Built executable | Fixed (now covered) | `esbuild.config.ts` honours `SPINDLE_LSP_OUTFILE`; `test/integration/support/dist-build.ts` runs `npm run build` into a temp dir. `B76-dist-*` cover no-arg and `--stdio` initialize, `--help`, `--version`. |

Existing `F66-2` / `C-F66 (2)` now normalize both sides to LF before
comparing payloads and additionally assert the output stays CRLF.
