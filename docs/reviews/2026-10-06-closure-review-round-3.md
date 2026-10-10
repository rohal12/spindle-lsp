# Closure validation — 2026-10-06, round 3

The implementation is converging, but closing every GitHub issue did not close
every demonstrated contract. All previous closure reproductions are repaired.
Bounded expansion around the repaired formatter and expression targets confirms
two surviving contracts, owned by **#66 and #77**. Both failures also reproduce
at `320af88718a7c19c473085ceb58f25d44bcefb41`; neither is classified as a newly
introduced regression. No new defect ticket is needed.

## Reviewed state and scope

- Published main: `51c94c807fc514d0d98c0a4089b61da5661fd1bc`.
- Tested isolated source snapshot: `29602ac938f07436358cb0601d113a9b76df6efa`.
  GitHub's comparison to main reports one merge commit and **no changed files**.
  PR #84 merged the review repairs; PR #85 merged the passage-collision guard.
- Node 22.18.0; spindle-lsp 0.9.0; installed Spindle 0.45.1.
- The workspace initially contained uncommitted collision-guard changes; these
  were committed externally during review. Source snapshots kept the initial
  merged tree and the subsequent collision repair separate. The reviewer made
  no product changes, commits or pushes. Earlier untracked reports are retained.
- GitHub initially reported zero open tickets. This report records the evidence
  for reopening two existing defect owners and their parent tracker.

The review inspected the complete changes since the preceding `320af88`
checkpoint, including the changed test oracles and the later collision guard.
It reran the historical corpus, preceding closure probes, required normal gate,
retained consumer matrix and supported-version boundaries. Additional checks
were bounded to the changed lexical context and target-identity behavior. This
does not claim an exhaustive audit of every possible JavaScript expression.

## Retained evidence

| Measurement | Previous checkpoint | Current result |
| --- | --- | --- |
| Historical case IDs | 61 pass | 61 pass; none missing |
| Previous matrix cells | 3,995 | All IDs and states retained |
| Additional matrix cells | — | 1,214 pass |
| Current matrix states | 3,982 pass / 13 not applicable | 5,196 pass / 13 not applicable; zero fail or not run |
| Normal suite | 2,023 tests | 2,070 tests in 81 files |
| Matrix Vitest total | 3,995 tests | 5,209 tests in 18 files |

Fresh `npm test` and `npm run typecheck` pass on the installed 0.45.1 source
snapshot. Normal tests, typecheck and the separately invoked mandatory matrix
also pass against packed **0.43.0, 0.50.0, 0.50.1, 0.51.0, 0.51.1 and 0.51.3**.
All six peer runs have 2,070 passing normal tests and a passing 5,209-cell matrix.
These are seven checked releases, not a new check of every published release.
The peer script alone runs normal tests and typecheck; the matrix was explicitly
run afterwards. Vitest's matrix total includes the 13 not-applicable bookkeeping
assertions; those are not skipped product assertions.

The seven round-1 probes pass, including raw do-body context, BOM coordinates
and variable-name grammar. Round-2's `_x1` and `URL` renamed-target probes now
preserve the requested names using the installed expression evaluator, including
a populated temporary scope. The regex-assignment formatting case is repaired.
The quoted `inline` diagnostic case now agrees with references on 0.51.1 and
0.51.3, while preserving the older 0.45.1 behavior. The collision guard rejects
renaming onto another passage and retains the previously omitted matrix
candidate, rather than skipping it. No failure was weakened or marked expected.

## [P1] Preserve templates after control-flow regex statements — #66

Location: `src/plugins/format.ts:247–249`.

```twee
:: StoryVariables
:: Start
{do}
if (true) /`/.test("x");
const value = `a
b`;
temporary.reviewValue = value;
{/do}
```

Before formatting, the runtime stores `"a\nb"`. After formatting it stores
`"a\n  b"`. The closing parenthesis of an `if`, `while` or `for` condition ends
the condition and permits a regex expression statement. The scanner treats
every `)` as the end of a value, so the slash is treated as division and the
backtick inside the regex as a template opener. The real multiline template is
then exposed to indentation. Idempotence passes despite the changed value.

Stable additions to the existing do-literal context table:

| Context ID | Both brace readings, LF and CRLF |
| --- | --- |
| `F66/if-regex-expression` | Four failures |
| `F66/while-regex-expression` | Four failures |
| `F66/for-regex-expression` | Four failures |
| regex assignment, braced if, division, postfix division, object division, Unicode identifier controls | 24 passes |

The three failing contexts were also checked through the **actual** 0.45.1 and
0.51.3 tokenizer, AST builder, `collectText`, Do render function and expression
`execute`, with fixed benign source and compiler-normalized CRLF. All twelve
runtime checks reproduce the value change; eight assignment/braced controls
pass. This corroborates the lexical checks rather than adding another defect.
All twelve lexical failures also fail on the preceding `320af88` implementation.

The latest closure comment disclosed a previous-token heuristic limitation;
that does not make valid JavaScript exempt from the value-preservation contract.
Extend the existing `DO_LITERALS` table with these control-flow contexts and
retain exact values, wrappers, both readings, LF/CRLF and division controls in
the normal gate with the repair. Do not add an expected-failure exception.

## [P1] Exclude runtime-bound expressions from static passage targets — #77

Locations: `src/core/parsing/link-parser.ts:547–553` and
`src/plugins/diagnostics.ts:1222–1228`.

```twee
:: StoryVariables
:: temporary [widget]
{widget "greet"}hi{/widget}
:: Start
{goto temporary} {include temporary}
:: \[object Object\]
Real destination
```

Spindle's evaluator binds `temporary` to its temporary-scope object. Its actual
Goto/Include components navigate/render `String(result)`, here
`"[object Object]"`; this is an existing destination in the fixture. Neither
expression refers to the passage named `temporary`.

Nevertheless, the LSP reports two references to `temporary`, navigates to its
definition, permits passage prepare-rename on the argument, shows a two-reference
lens, and emits SP302 for including the unrelated widget-definition passage.
Renaming that header to `Fresh` produces:

```twee
{goto "Fresh"} {include "Fresh"}
```

Applying those edits changes the expressions' actual target from
`"[object Object]"` to `"Fresh"`. The quoting repair correctly encodes the new
name, but the input was incorrectly classified as a reference in the first
place. This is #77's existing static/dynamic identity and shared-diagnostic
contract, with #67 as its encode/decode interaction control.

Stable additions: `L77/expression-identity/<name>/<bare-or-quoted>/<version>`.
Seven input spellings—`temporary`, `variables`, `locals`, `transient`, `Math`,
`URL` and `_5`—are wrongly treated as static passage names on both 0.45.1 and
0.51.3: **14 failures**. The four evaluator scopes are bound objects, Math/URL
are globals, and Spindle transforms `_5` into `temporary["5"]` (empty scope gives
`undefined`). Every corresponding quoted-name control and ordinary bare/quoted
`Plain` control passes: **18 controls**. The actual published evaluator sources
for both releases were compiled with fixed benign store state; no project
expression was evaluated. Definition, prepare-rename and code-lens evidence is
recorded independently; document links correctly returned zero for these macro
forms and are not claimed as a failing consumer.

All fourteen identity failures also reproduce at `320af88`, before the latest
target-encoding and include-diagnostic repairs. These are surviving gaps, not
fourteen introduced bugs. The newly strengthened oracle tests evaluate these
spellings as **rename outputs**, but do not cover them as **input expressions**.

Extend the existing goto/include spelling family with runtime-bound input
expressions and their quoted controls. Assert absence of false passage
references/definitions/prepare-rename, false reference counts and SP302, and
preserve these expressions when applying a rename to an unrelated declaration.
Include empty/populated temporary scopes, both boundary runtimes, original
escape/range controls and the now-passing quoted-inline cases. Decide identity
statically; never evaluate author expressions in production to classify them.

## Finite next review gate

1. Keep all 61 historical IDs and all 5,209 current matrix IDs/states.
2. Add the three control-flow regex contexts to F's existing table and the
   runtime-bound input spellings/quoted controls to the existing target family
   with their repairs. Retain desired-behavior assertions in `npm test`.
3. Repair #66 and #77, checking #67's now-passing encoding and collision controls.
   #67 does not need a second ticket for input misclassification owned by #77.
4. Recheck the exact new observations, affected consumers and runtime boundaries,
   then normal tests/typecheck. Compare retained states and added coverage
   separately. Keep #81 open until these two contracts pass their gates.

The new probe observations are retained separately in
`2026-10-06-closure-review-round-3-results.json`; they have not been inserted as
expected failures into the green production matrix. The following repair must
promote these context/spelling additions into the existing executable tables.
This review changes documentation and ticket dispositions only.

## Follow-up audit of this session's omissions

The preceding findings and recorded passing results remain supported. The
session did not complete a systematic inventory of semantic decisions before
selecting its additional probes. The following coverage limits were left
implicit or deferred rather than recorded as individual not-run cells:

| Check for the newly discovered cases | State in this session |
| --- | --- |
| Semantic-decision inventory with an explicit disposition for each selected contract cell | Not completed; additions were selected during investigation |
| Nested macros, HTML/prose wrappers and other passage roles for the new control-flow regex cases | Not run; their new probes used a standalone ordinary-passage do block |
| Multiple documents and unsaved-edit/document-lifecycle variants for the new bound-expression input cases | Not run; their new probes used one fresh LF document |
| Populated temporary scopes for the new bound-expression input cases | Not run; populated scopes were checked for renamed output spellings, a different check |
| Fresh workspace rebuild and diagnostics/reference checks after applying the new input-expression rename probes | Not run; edits were applied and runtime target changes verified without rebuilding the resulting workspace |
| New reproductions through bundled LSP, CLI and MCP entrypoints | Not run; existing entrypoint tests passed on their existing fixtures |
| New reproductions through actual runtime sources for every checked peer version | Run on 0.45.1 and 0.51.3 only; the retained normal/matrix suites passed on all seven checked versions |
| Executable regression checks for the new contexts/spellings retained in the repository's normal gate | Not added; results/source examples were retained in documentation and JSON, while the probe programs remained under `/tmp/spindle-closure-round3` |

These are unperformed checks, not additional confirmed product defects. Some
were already listed as subsequent repair requirements, but listing them there
did not establish coverage in this review. The green normal gate does not yet
exercise these new cases. Before the corresponding contracts are closed, the
repair must retain executable desired-behavior checks and explicitly disposition
the remaining relevant cells. This follow-up documents the omissions; it does
not claim to have completed them.
