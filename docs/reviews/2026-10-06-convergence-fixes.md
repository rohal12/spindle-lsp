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
