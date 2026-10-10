# Open-ticket reconciliation — 2026-10-06

Audited all 15 open GitHub tickets after the round-2 review, at unchanged
`320af88718a7c19c473085ceb58f25d44bcefb41`. The preceding review's two findings
were demonstrated defects in its bounded scope, not a count of open issues or
a blanket disposition of the backlog. This reconciliation explicitly checks
the remaining tickets' acceptance criteria against retained evidence.

**Result: eleven verified defect tickets closed; four tickets remain open.**
The four are three defect owners (#66, #67, #77) and tracker #81. #77 has an
additional demonstrated consumer mismatch, as well as its stated interaction
gate with #67. No new ticket is needed for another instance of its contract.

## Closed with evidence

These fixes are in the published `fix/review-convergence` branch at 320af88.
Closing records completed branch fixes, **not a claim that main has merged them**.
Each issue now has checked acceptance criteria and a closure note with fixing
commits, test evidence and publication scope; the original baseline is retained.

| Issue | Contract | Retained acceptance evidence |
| --- | --- | --- |
| #68 | Safe creation destination | Q68/H78/M-SP202, configs and JS/TS opening orders, unsaved/non-.tw buffers, no-story safe result and applied/rebuilt creation; framed LSP action |
| #69 | Valid declaration insertion | Q69 for both sigils, EOF value/header/newline, LF/CRLF, next passage and multi-file destination; applied output parsed by runtime; M-EOL |
| #71 | Literal link labels | X71/C-X71, runtime token comparisons, unknown/closing labels, adjacent blocks and malformed-link controls; shared-consumer matrix |
| #72 | Passage-role diagnostic masking | X72/C-X72 data/declaration variants, SP204/SP207 controls, executable StoryInit/StoryInterface and role matrix |
| #73 | StoryInterface variable index | V73 paths/transients/applied rename/unsaved updates, literal and startup controls; independently verified declaration lens changes from 3 to 2 usages after an unsaved interface edit |
| #74 | Widget-head grammar | W74/G74 invocation and declaration navigation/rename, CSS/hyphens, paired/stray closers, literal exclusions and builtin precedence; runtime head differential |
| #75 | Applied closing completion | E75 exact applied textEdit, partial names, nested blocks, boundaries and preserved surrounding text; framed public LSP completion |
| #76 | Public stdio launch | Built executable B76-dist/C-B76 framed initialize, help/version/check controls; CLI/formatter/MCP integration dispatch |
| #78 | Required StoryVariables | D78/C-D78 loading/format controls; error severity and CLI exit 1/0 tests; H78/M-SP202 ownership; applied LSP quickfix clears error |
| #79 | Signature schema/active argument | H79/N-sig named parameters, partial boundaries, alternatives/repetition, typed-prefix selection, widget separators, CSS/multiline and wire-label offsets |
| #80 | Valid non-overlapping token spans | S80 whole variables, templates, multiline/CRLF/UTF-16 and no-overlap checks; corrected unsupported sugar-keyword premise against runtime evidence |

#80's original criterion about preserving real SugarCube-style keyword operators
was corrected explicitly: Spindle has no such operators. The implementation
removed artificial keyword tokens while preserving variable spans and the
legend. This follows the documented runtime finding in the existing convergence
fix ledger; no product test was weakened or changed by this ticket audit.

Verification reused the immediately preceding round-2 run at exactly this
unchanged HEAD: installed 0.45.1 `npm test` and typecheck pass, with 2,023 normal
tests and 3,995 matrix tests (3,982 applicable passes and 13 not-applicable).
Normal tests, matrix and typecheck also pass on packed 0.43.0, 0.50.0, 0.50.1,
0.51.0, 0.51.1 and 0.51.3. All 61 historical IDs remain passing; all prior
matrix cells are retained. No additional full-suite run was necessary for
issue/documentation-only changes.

## Remaining tickets

| Issue | Current disposition |
| --- | --- |
| [#66](https://github.com/rohal12/spindle-lsp/issues/66) | Active: regex backtick confuses protection of a later template; formatting changes its value |
| [#67](https://github.com/rohal12/spindle-lsp/issues/67) | Active: underscore-leading target rename becomes a temporary-variable expression; related global-name variant remains unsafe |
| [#77](https://github.com/rohal12/spindle-lsp/issues/77) | Decoder cases pass, but target identity disagrees with widget-include diagnostics on modern inline handling; retain its #67 interaction gate |
| [#81](https://github.com/rohal12/spindle-lsp/issues/81) | Parent convergence tracker; remains open until these contracts close |

## Extended #77 contract: modern include target identity

Stable addition: `L77/include-inline-diagnostic-0.51.3`.

```twee
:: StoryData
{"format":"Spindle","format-version":"0.51.3"}
:: StoryVariables
:: inline [widget]
{widget "greet"}hi{/widget}
:: Start
{include "inline"}
```

With no installed workspace runtime, the model selects 0.51.3 from StoryData.
The reference parser resolves a reference to passage `inline`. The runtime's
scoped inline-flag handling also preserves the quoted target. Nevertheless,
`resolveIncludeTarget('"inline"')` in diagnostics returns the empty string and
`computeDiagnostics()` omits SP302 (including a widget-definition passage does
not invoke its widgets). Changing both the header and target to `Other` gives
the expected SP302 warning. SP303 on the unused widget is present in both cases.

Cause: `src/plugins/diagnostics.ts:589` removes the first word `inline` even
inside quotes; `resolveIncludeTarget` at line 1216 and its SP302 caller at line
1273 do not take the target capabilities. Meanwhile the shared reference parser
has version-aware preprocessing. This violates #77's existing requirement for
consistent identity between references and include-target diagnostics. It is
a remaining version-specific contract gap; introduction by the latest commit
has not been established.

Closure extension: add this target spelling to the existing include-target
family and independently assert reference identity and SP302 for 0.51.1/0.51.3.
Keep the older 0.45.1 quoted-inline behavior, a normal `Other` widget passage,
quoted and bare targets, leading/trailing flags, malformed/dynamic targets and
original escaped source ranges as controls. Reuse the installed runtime's
version-specific expression preprocessing. Check #67's applied rename value
preservation before closing the explicit interaction gate. No new owner or
unbounded implementation audit is required.
