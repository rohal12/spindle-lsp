# Working on spindle-lsp

For reviews, regression fixes, or issue triage, read
[the review process](docs/reviews/process.md). Start from its existing contract
corpus and issue ownership map; extend the relevant contract before filing a
new issue for another instance of the same failure.

Normal checks: `npm test` and `npm run typecheck`. `npm test` runs the unit and
integration suite (`npm run test:unit`) and then the retained cross-consumer
matrix (`npm run review:convergence`, `test/review/convergence.review.ts`), so
a failing matrix cell fails the normal gate. Every cell must pass: a failure is
a defect to fix in `src/`, never a result to report as expected. Do not skip,
invert, or weaken assertions to make it green. Cell names, states and the
latest results are in `docs/reviews/2026-10-06-cross-consumer-results.json`
(regenerate with `REVIEW_WRITE_RESULTS=1 npm run review:convergence`).

Review scope follows the user's request. A diff review reports introduced
regressions; a full implementation audit can report existing defects and must
identify them as such. Review does not authorize product fixes or commits.
