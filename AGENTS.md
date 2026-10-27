# Working on spindle-lsp

Parsing comes from Spindle, not from this repo: the markup tokenizer, the
paired tree, the code pieces, passage references, widget and variable
declarations, variable validation and the diagnostics are `@rohal12/spindle/tooling`
(minimum 0.60.0, `MINIMUM_SPINDLE_VERSION`; the build bundles the pinned
dependency, so the LSP's rules are that release's). Consumers read it through
`workspace.markup` (`src/core/markup`), which maps the API's offsets into
`content` back to document positions. Do not re-implement a rule the API owns,
and do not work around a gap in it: file an issue on rohal12/spindle (the
maintainers are responsive), and keep the old behavior out.
The runtime is the oracle: tests use the same public API (`test/helpers`).

Normal checks: `npm test` (the unit and integration suite) and
`npm run typecheck`. A failing test is a defect to fix in `src/`; do not skip,
invert, or weaken assertions to make it green.

Duplication in `src/` is checked by jscpd, PMD CPD and fallow against
`duplication-budget.json` (`npm run duplication`; CPD needs `PMD_BIN` pointing
at PMD's `bin/pmd`, and `--base <ref>` also compares with that ref). CI runs
them in the `Duplication` workflow; a change must not add duplication, and
lowering a budget after reducing it is welcome, raising one needs a reason.

A pull request merges into `main` only when the checks the `main` ruleset
requires pass (`test (24)`, the three `duplication` jobs, `Analyze (actions)`,
`Analyze (javascript-typescript)`, `dependency-review`, `zizmor`) and it adds no
CodeQL or zizmor alert of high or critical security severity and no
error-level alert. Fix such a finding, or dismiss a false positive with its
reason; do not work around the gate. Every action in `.github/workflows` is
pinned to a full commit SHA with its version in a comment: the repository
refuses to run an unpinned one, and Dependabot updates the pins.

Review scope follows the user's request. A diff review reports introduced
regressions; a full implementation audit can report existing defects and must
identify them as such. Review does not authorize product fixes or commits.

Before a release that touches packaging (dependencies, `files`, the esbuild
externals) or the play tools, run `npm run smoke:pack`. It packs spindle-lsp,
installs the tarball into a fresh project outside the repository, starts the
installed `dist/bin.js mcp` and plays `test/fixtures/play/story.twee` through
`spindle_play_start`, so a dependency that npm users would not get fails here
and not only for them. While `@rohal12/spindle` is a `file:` dependency, the
linked Spindle checkout must already be built; it is packed with its scripts
off. The project goes under `SMOKE_PACK_DIR`, else the system temp directory,
and the script refuses a directory with a `node_modules`, `package.json` or
`.git` above it (on a machine with a stray `/tmp/node_modules`, set
`SMOKE_PACK_DIR`). CI runs it after the build.

The Claude Code plugin is `plugins/spindle-lsp`, listed by the repository's
marketplace (`.claude-plugin/marketplace.json`). It runs the latest npm release
through `npx`, so it carries no version to bump; check it with
`claude plugin validate .`.
