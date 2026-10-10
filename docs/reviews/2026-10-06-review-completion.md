# Completing the omitted closure checks

This follows the round-3 review. The user clarified that the task is validation
and filing bug issues, not repository test development. Checks will use temporary
reproduction programs and findings will extend their GitHub owners. Test changes
briefly prepared by the reviewer were removed. Product fixes and commits remain
outside this review's authorization.
The source baseline is `29602ac938f07436358cb0601d113a9b76df6efa` (the tree merged
as main `51c94c807fc514d0d98c0a4089b61da5661fd1bc`).

## Coverage obligations selected before execution

| Decision or consumer | Required checks |
| --- | --- |
| Regex versus division | Regex after assignment, keywords, condition parentheses and blocks; division after a value, grouped/indexed value, postfix increment and object value; comments, escapes and character classes |
| Literal preservation | Exact executed do values, idempotence, LF/CRLF, both brace readings, standalone/indented/inline/nested/HTML/button/prose wrappers |
| Passage role | Ordinary, widget, StoryInit and StoryInterface; script and stylesheet literal controls |
| Expression identity | Runtime-bound parameters/globals/digit-leading temporaries as input; quoted versions and unbound ordinary names as controls; goto and include independently |
| Runtime state | Empty and populated temporary scopes, using the actual installed expression evaluator on fixed fixtures |
| Navigation consumers | References, definition, passage prepare-rename, lenses and include diagnostics checked independently |
| Applied rename | Apply all document edits, rebuild a fresh workspace, recheck identities/diagnostics and evaluate both macro destinations; preserve unrelated expression text |
| Editor state | Multiple files, initialization order, unsaved bare/quoted transitions, add/remove, close/reopen, and comparison with fresh workspaces |
| Public entrypoints | Bundled framed LSP formatting, navigation, rename and unsaved changes; CLI and MCP formatting and diagnostics; MCP has no rename tool |
| Runtime boundaries | Execute the new checks with installed 0.45.1 and packed 0.43.0, 0.50.0, 0.50.1, 0.51.0, 0.51.1 and 0.51.3 |
| Retention | Preserve reproducible fixtures, results and independent consumer expectations in the issue contracts; corpus additions belong to the subsequent repair |

No check may use an expected-failure marker or invert the desired assertion.
Existing source defects can make the new normal gate fail; those failures keep
their existing owners #66/#77 and are not a green review result. Test-fixture or
oracle errors must be corrected and rerun before assigning product ownership.

Execution results will be appended after the checks finish.
