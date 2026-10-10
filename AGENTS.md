# Working on spindle-lsp

For reviews, regression fixes, or issue triage, read
[the review process](docs/reviews/process.md). Start from its existing contract
corpus and issue ownership map; extend the relevant contract before filing a
new issue for another instance of the same failure.

Parsing comes from Spindle, not from this repo: the markup tokenizer, the
paired tree, the code pieces, passage references, widget and variable
declarations, variable validation and the diagnostics are `@rohal12/spindle/tooling`
(minimum 0.59.20, `MINIMUM_SPINDLE_VERSION`; the build bundles the pinned
devDependency, so the LSP's rules are that release's). Consumers read it through
`workspace.markup` (`src/core/markup`), which maps the API's offsets into
`content` back to document positions. Do not re-implement a rule the API owns,
and do not work around a gap in it: file an issue on rohal12/spindle (the
maintainers are responsive), keep the old behavior out, and say so in the
review ledger ([migration ledger](docs/reviews/2026-10-10-tooling-migration.md)).
The runtime is the oracle: tests use the same public API (`test/helpers`).

Normal checks: `npm test` and `npm run typecheck`. `npm test` runs the unit and
integration suite (`npm run test:unit`) and then the retained cross-consumer
matrix (`npm run review:convergence`, sharded over `test/review/shard-*.review.ts`), so
a failing matrix cell fails the normal gate. Every cell must pass: a failure is
a defect to fix in `src/`, never a result to report as expected. Do not skip,
invert, or weaken assertions to make it green. Cell names, states and the
latest results are in `docs/reviews/2026-10-06-cross-consumer-results.json`
(regenerate with `REVIEW_WRITE_RESULTS=1 npm run review:convergence`).

Duplication in `src/` is checked by jscpd, PMD CPD and fallow against
`duplication-budget.json` (`npm run duplication`; CPD needs `PMD_BIN` pointing
at PMD's `bin/pmd`, and `--base <ref>` also compares with that ref). CI runs
them in the `Duplication` workflow; a change must not add duplication, and
lowering a budget after reducing it is welcome, raising one needs a reason.

Review scope follows the user's request. A diff review reports introduced
regressions; a full implementation audit can report existing defects and must
identify them as such. Review does not authorize product fixes or commits.
