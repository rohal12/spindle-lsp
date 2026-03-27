# Transient Variable LSP Support — Design Spec

**Date:** 2026-03-27
**Related:** rohal12/spindle#137 (engine implementation merged)

## Problem

Spindle now supports `%` transient variables (reactive, excluded from persistence). The LSP needs to recognize the `%` sigil for syntax highlighting, completions, hover, diagnostics, references, rename, and inlay hints — with full parity to `$` story variable support.

## Changes

### Types

In `core/types.ts`, add `'%'` to the `DeclaredVariable.sigil` union type.

### Parsing Layer

**Argument lexer** (`core/parsing/argument-lexer.ts`):
- Add `%` to `varTestRegexp` regex and `Arg.sigil` type union.

**Macro parser** (`core/parsing/macro-parser.ts`):
- Add `%` to `variableInterpolationRegex` so `{%var}` patterns are cleaned before macro parsing.

### Variable Tracker

In `core/workspace/variable-tracker.ts`:

- Add `parseStoryTransients(content: string)` — same logic as `parseStoryVariables` but matches `%name = value` lines with `sigil: '%'`.
- Update usage-scanning regex (`varRefRegex`) to also match `%name` references.
- The workspace model calls `parseStoryTransients` when a passage named `StoryTransients` is found, same lifecycle as `StoryVariables`.

### Completions

In `plugins/completions.ts`:

- Add `'%'` to `triggerCharacters`.
- Add transient variable context regex: `/%[A-Za-z_$]?[\w$]*$/`.
- Add `getTransientVariableCompletions()` returning declared `%` variables from workspace.
- Add `%var.` dot-path completion regex and handler (same pattern as `$var.`).

### Diagnostics

In `plugins/diagnostics.ts`:

- When a `StoryTransients` passage exists, validate `%` references against declarations — emit undeclared transient variable diagnostics (new code, e.g., SP203).
- When no `StoryTransients` passage exists, do not warn about `%` references (the passage is optional in Spindle).

### Hover

In `plugins/hover.ts`:

- Add `%` variable regex: `/(?<!\w)%([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g`.
- Return hover: "**Transient variable** \`%varName\`" with field info from declarations.

### Semantic Tokens

In `plugins/semantic-tokens.ts`:

- Add `%` variable regex: `/(?<!\w)%([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g`.
- Token type: `'variable'` with modifier `'defaultLibrary'` (to visually distinguish from `$` global, `_` local, `@` readonly).

### References

In `plugins/references.ts`:

- Add `%` to variable reference regex so Find All References works for transient variables.
- Include `StoryTransients` declaration location in results.

### Rename

In `plugins/rename.ts`:

- Add `%` to renameable variable regex.
- Rename updates both the `StoryTransients` declaration and all `%` usages.

### Inlay Hints

In `plugins/inlay-hints.ts`:

- Recognize `%name = value` lines in `StoryTransients` passage for type inference hints (same as `$` in `StoryVariables`).

### Documentation

In `macro-supplements.json`:

- Update `{set}` and `{unset}` macro descriptions to mention `%var` (transient) alongside `$var`, `_var`, `@var`.

### Code Actions

In `plugins/code-actions.ts`:

- If there's a quick-fix to declare undeclared `$` variables in `StoryVariables`, add the equivalent for undeclared `%` variables in `StoryTransients`.

## Testing

Add `%` test cases mirroring existing `$` patterns in each plugin test file. Key scenarios:

- Completion triggers on `%` and `%var.`
- Hover shows "Transient variable" with fields
- Semantic tokens classify `%var` correctly
- Undeclared `%var` diagnostic when `StoryTransients` exists
- No diagnostic when `StoryTransients` is absent
- References find all `%var` usages
- Rename updates declaration + usages
- Inlay hints show type in `StoryTransients`
- `{%var}` cleaned from macro parsing context

## Scope Boundaries

### In scope
- Full `%` sigil parity with `$` across all LSP features
- `StoryTransients` passage parsing
- Tests for all new behavior

### Out of scope
- Cross-scope name collision detection (engine handles this at boot)
- `storeVar` rejection (engine-side concern, not LSP)
