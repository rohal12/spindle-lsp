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
