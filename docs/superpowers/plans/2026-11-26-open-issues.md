# Open issues #311–#313 implementation plan

**Goal:** Fix all currently open issues in one pull request.
**Architecture:** Keep the runtime-owned analysis unchanged. Reuse config preparation within each code-action request, group effective widgets by their containing passage once per outline request, and allow widget spelling changes that preserve identity.
**Tech stack:** TypeScript, Vitest, YAML, the existing workspace model.
**Spec:** GitHub issues #311, #312, #313 and AGENTS.md.

## Constraints and review focus

Preserve authoritative unsaved config contents, YAML aliases, independent action edits, stale diagnostic rejection, regular-file guards, effective widget selection, StoryInit definitions, and collision rejection for distinct bindings. Do not add duplication or change runtime-owned parsing.

### Task 1: Case-only widget renames (#313)

- [ ] Add a regression in `test/unit/rename.test.ts` for both declaration and invocation cursors, builtin overrides and ordinary widgets, plus distinct-destination collision controls.
- [ ] Run the test and confirm builtin overrides fail with RenameError.
- [ ] Adjust the macro collision guard in `src/plugins/rename.ts` to exempt the same case-insensitive identity.
- [ ] Run the rename tests; expect all to pass.
- [ ] Commit the fix with its regressions.

### Task 2: Outline widget indexing (#312)

- [ ] Add operation-count coverage in `test/unit/document-symbol.test.ts` varying passage/widget counts, including other documents. Verify child names and tooling ranges, StoryInit, duplicates, edits and removals.
- [ ] Run the tests and confirm repeated registry enumeration fails the work bound.
- [ ] In `src/plugins/document-symbol.ts`, fetch effective widgets once, assign them to passages by ordered passage boundaries, and attach the indexed children without a passage × widget scan.
- [ ] Run the outline tests; expect all to pass.
- [ ] Commit the fix with its regressions.

### Task 3: Request-local config preparation (#311)

- [ ] Add populated-config operation-count regressions in `test/unit/code-actions-config.test.ts` for disk and live YAML, and independence tests for fallback YAML/aliases and JSON actions.
- [ ] Run the tests and confirm reads/parsing repeat per diagnostic.
- [ ] In `src/plugins/code-actions.ts`, lazily select/read/prepare the config once per request and return a per-name edit factory. Inspect existing names once; mutate only per-action copies where necessary.
- [ ] Run the code-action tests; expect all to pass.
- [ ] Commit the fix with its regressions.

### Final verification and delivery

- [ ] Run all tests with clean temporary fixtures, typecheck, build, and all three duplication checks against the branch base. Expect every check to pass without additional duplication.
- [ ] Obtain an independent diff review and resolve substantive findings.
- [ ] Re-check open issues and existing PRs, push the branch, open one PR closing all fixed issues, and inspect its checks.
