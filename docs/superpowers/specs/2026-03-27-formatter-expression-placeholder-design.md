# Formatter Expression Placeholder Fix

**Issue**: [#8](https://github.com/rohal12/spindle-lsp/issues/8) — Formatter breaks inline `style` attributes containing `{expression}` across lines

**Date**: 2026-03-27

## Problem

The formatter's placeholder system (`placeholders.ts`) uses `SPINDLE_TOKEN_REGEX` to protect Spindle tokens from Prettier reformatting. The regex only matches simple variable references like `{$var}`, `{@node.tier}` — it cannot match expression interpolations containing operators or spaces like `{@node.tier + 1}`.

When these unprotected expressions appear inside HTML attributes (e.g. `style="grid-row: {@node.tier + 1}"`), Prettier reformats the attribute value across multiple lines. In `[nobr]` passages where newlines are stripped, this moves CSS semicolons inside `{...}` expression braces, which Spindle evaluates as empty.

## Solution

Replace `SPINDLE_TOKEN_REGEX` with a character-level scanner function that uses brace-depth tracking. This handles arbitrary nesting (e.g. `{@list[{$index}]}`) and is more readable than a mega-regex.

## Design

### Token Scanner

A new function `scanSpindleTokens(text: string)` walks the string character-by-character and returns an array of `{start: number, end: number, token: string}` objects.

**Token recognition rules** (checked in order when `{` is encountered):

1. **Escaped brace**: preceding `\` — skip, not a token
2. **Closing tag**: `{` `/` `[A-Za-z]` — scan with brace depth to matching `}`
3. **CSS-prefixed macro**: `{` `#` or `.` followed by letter — scan with brace depth to `}`
4. **Macro call**: `{` `[A-Za-z]` — scan with brace depth to `}`
5. **Variable/expression interpolation**: `{` `[$_@%]` `[a-zA-Z]` — scan with brace depth to `}`
6. **Link**: `[[` — scan to `]]`

The brace-depth tracking is the same for all `{...}` cases: walk forward, increment depth on `{`, decrement on `}`, stop when depth reaches 0.

### Updated `replaceSpindleTokens`

The line-by-line logic stays structurally identical:

1. **Scan the line** for tokens using `scanSpindleTokens(trimmed)`
2. **No tokens** — push line as-is
3. **Tokens found, no HTML** — replace entire line with one `<!--SP:N-->` placeholder
4. **Tokens found + HTML** — replace individual tokens from right-to-left (preserving offsets):
   - Inside attribute values: `__SPN__`
   - In HTML content: `<!--SP:N-->`

HTML detection uses `HTML_TAG_REGEX` on the text after removing scanner-found token substrings (same logic as before, but using position data rather than regex `.replace()`).

### No Changes

- `restoreSpindleTokens` — untouched (still finds `<!--SP:N-->` and `__SPN__`)
- `replaceSvgBlocks` / `restoreSvgBlocks` — untouched
- `isInsideAttribute` — reused as-is
- `segment.ts`, `prettier-bridge.ts`, `format.ts` — untouched
- `SPINDLE_TOKEN_REGEX` is removed (fully replaced by scanner)

## Testing

- Existing placeholder round-trip tests must continue to pass
- Add tests for expression interpolations: `{@node.tier + 1}`, `{$health * 2}`
- Add test for nested braces: `{@list[{$index}]}`
- Add test for `%` transient sigil: `{%temp}`
- Add integration test: `formatDocument` with HTML containing style attribute expressions should not split them across lines
