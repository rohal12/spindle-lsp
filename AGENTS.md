# Working on spindle-lsp

For reviews, regression fixes, or issue triage, read
[the review process](docs/reviews/process.md). Start from its existing contract
corpus and issue ownership map; extend the relevant contract before filing a
new issue for another instance of the same failure.

Normal checks: `npm test` and `npm run typecheck`.
Backlog audit: `npm run review:convergence`. That audit currently asserts desired
behavior for open issues and fails; report its failures separately from normal
test results. Do not skip, invert, or weaken assertions to make it green.

Review scope follows the user's request. A diff review reports introduced
regressions; a full implementation audit can report existing defects and must
identify them as such. Review does not authorize product fixes or commits.
