# Formatter Expression Placeholder Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #8 — replace the regex-based Spindle token matcher in `placeholders.ts` with a character-level scanner that handles expression interpolations like `{@node.tier + 1}` and nested braces like `{@list[{$index}]}`.

**Architecture:** A new exported `scanSpindleTokens()` function walks text character-by-character, using brace-depth tracking to find Spindle tokens. `replaceSpindleTokens()` is updated to use the scanner instead of `SPINDLE_TOKEN_REGEX`, which is removed. All other files are untouched.

**Tech Stack:** TypeScript, Vitest

---

## File Map

- **Modify:** `src/plugins/format/placeholders.ts` — remove `SPINDLE_TOKEN_REGEX`, add `scanSpindleTokens()`, update `replaceSpindleTokens()`
- **Modify:** `test/unit/placeholders.test.ts` — add scanner tests, add expression interpolation tests
- **Modify:** `test/unit/format.test.ts` — add integration test for style attribute with expressions

---

### Task 1: Implement `scanSpindleTokens` with TDD

**Files:**
- Create tests in: `test/unit/placeholders.test.ts`
- Implement in: `src/plugins/format/placeholders.ts`

- [ ] **Step 1: Write failing tests for the scanner**

Add this new `describe` block at the end of `test/unit/placeholders.test.ts`:

```typescript
describe('scanSpindleTokens', () => {
  it('finds closing tags', () => {
    const result = scanSpindleTokens('hello {/if} world');
    expect(result).toEqual([{ start: 6, end: 11, token: '{/if}' }]);
  });

  it('finds macro calls', () => {
    const result = scanSpindleTokens('text {set $x = 1} more');
    expect(result).toEqual([{ start: 5, end: 17, token: '{set $x = 1}' }]);
  });

  it('finds CSS-prefixed macros', () => {
    const result = scanSpindleTokens('{.red#alert if $x}');
    expect(result).toEqual([{ start: 0, end: 18, token: '{.red#alert if $x}' }]);
  });

  it('finds simple variable interpolations', () => {
    const result = scanSpindleTokens('Hi {$name}!');
    expect(result).toEqual([{ start: 3, end: 10, token: '{$name}' }]);
  });

  it('finds expression interpolations with operators', () => {
    const result = scanSpindleTokens('row: {@node.tier + 1}');
    expect(result).toEqual([{ start: 5, end: 21, token: '{@node.tier + 1}' }]);
  });

  it('finds expression interpolations with nested braces', () => {
    const result = scanSpindleTokens('val: {@list[{$index}]}');
    expect(result).toEqual([{ start: 5, end: 21, token: '{@list[{$index}]}' }]);
  });

  it('finds % transient variable interpolations', () => {
    const result = scanSpindleTokens('temp: {%counter}');
    expect(result).toEqual([{ start: 6, end: 16, token: '{%counter}' }]);
  });

  it('finds [[links]]', () => {
    const result = scanSpindleTokens('go to [[Home]]');
    expect(result).toEqual([{ start: 6, end: 14, token: '[[Home]]' }]);
  });

  it('skips escaped braces', () => {
    const result = scanSpindleTokens('literal \\{not a macro}');
    expect(result).toEqual([]);
  });

  it('skips bare braces with no sigil or name', () => {
    const result = scanSpindleTokens('css { color: red }');
    expect(result).toEqual([]);
  });

  it('finds multiple tokens', () => {
    const result = scanSpindleTokens('{$a} and {$b}');
    expect(result).toHaveLength(2);
    expect(result[0].token).toBe('{$a}');
    expect(result[1].token).toBe('{$b}');
  });

  it('finds tokens adjacent to HTML', () => {
    const result = scanSpindleTokens('<span>{@node.tier + 1}</span>');
    expect(result).toEqual([{ start: 6, end: 22, token: '{@node.tier + 1}' }]);
  });
});
```

Also update the import at the top of the file to include `scanSpindleTokens`:

```typescript
import { replaceSpindleTokens, restoreSpindleTokens, scanSpindleTokens } from '../../src/plugins/format/placeholders.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/placeholders.test.ts`
Expected: FAIL — `scanSpindleTokens` is not exported from placeholders.ts

- [ ] **Step 3: Implement the scanner**

Add this interface and function to `src/plugins/format/placeholders.ts`, just above the `isInsideAttribute` function (before line 13). Also export the interface:

```typescript
export interface TokenMatch {
  start: number;
  end: number;
  token: string;
}

/**
 * Scan text for Spindle tokens using character-level brace-depth tracking.
 * Finds: closing tags, macro calls, CSS-prefixed macros, variable/expression
 * interpolations (with arbitrary nested braces), and [[links]].
 */
export function scanSpindleTokens(text: string): TokenMatch[] {
  const matches: TokenMatch[] = [];
  let i = 0;

  while (i < text.length) {
    // [[links]]
    if (text[i] === '[' && text[i + 1] === '[') {
      const closeIdx = text.indexOf(']]', i + 2);
      if (closeIdx !== -1) {
        const end = closeIdx + 2;
        matches.push({ start: i, end, token: text.slice(i, end) });
        i = end;
        continue;
      }
    }

    // {token} — skip escaped braces
    if (text[i] === '{' && !(i > 0 && text[i - 1] === '\\')) {
      const next = i + 1 < text.length ? text[i + 1] : '';
      let isToken = false;

      if (next === '/') {
        // Closing tag: {/Name}
        isToken = i + 2 < text.length && /[A-Za-z]/.test(text[i + 2]);
      } else if (next === '#' || next === '.') {
        // CSS-prefixed macro: {.class MacroName ...}
        isToken = i + 2 < text.length && /[a-zA-Z]/.test(text[i + 2]);
      } else if (/[A-Za-z]/.test(next)) {
        // Macro call: {MacroName ...}
        isToken = true;
      } else if (/[$_@%]/.test(next)) {
        // Variable/expression: {$var}, {@node.tier + 1}
        isToken = i + 2 < text.length && /[a-zA-Z]/.test(text[i + 2]);
      }

      if (isToken) {
        let depth = 1;
        let j = i + 1;
        while (j < text.length && depth > 0) {
          if (text[j] === '{') depth++;
          else if (text[j] === '}') depth--;
          j++;
        }
        if (depth === 0) {
          matches.push({ start: i, end: j, token: text.slice(i, j) });
          i = j;
          continue;
        }
      }
    }

    i++;
  }

  return matches;
}
```

- [ ] **Step 4: Run tests to verify scanner tests pass**

Run: `npx vitest run test/unit/placeholders.test.ts`
Expected: All `scanSpindleTokens` tests PASS. Existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/format/placeholders.ts test/unit/placeholders.test.ts
git commit -m "feat: add scanSpindleTokens character-level scanner

Brace-depth tracking handles expression interpolations like
{@node.tier + 1} and nested braces like {@list[{$index}]}.
Also supports % transient sigil."
```

---

### Task 2: Update `replaceSpindleTokens` to use scanner

**Files:**
- Add tests in: `test/unit/placeholders.test.ts`
- Modify: `src/plugins/format/placeholders.ts`

- [ ] **Step 1: Write failing tests for expression interpolation handling**

Add these tests inside the existing `describe('replaceSpindleTokens')` block in `test/unit/placeholders.test.ts`:

```typescript
  it('replaces expression interpolations with operators', () => {
    const input = '<div>{@node.tier + 1}</div>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(text).not.toContain('{@node.tier + 1}');
    expect(tokens[0]).toBe('{@node.tier + 1}');
  });

  it('replaces expression interpolations in attributes', () => {
    const input = '<div style="grid-row: {@node.tier + 1}">text</div>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(text).toContain('__SP0__');
    expect(text).not.toContain('{@node.tier');
    expect(tokens[0]).toBe('{@node.tier + 1}');
  });

  it('replaces nested brace expressions', () => {
    const input = '<span>{@list[{$index}]}</span>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(text).not.toContain('{@list');
    expect(tokens[0]).toBe('{@list[{$index}]}');
  });

  it('replaces % transient variable displays', () => {
    const input = '<span>{%temp}</span>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(text).not.toContain('{%temp}');
    expect(tokens[0]).toBe('{%temp}');
  });

  it('replaces multiple expression interpolations in style attribute', () => {
    const input = '<div style="grid-row: {@node.tier + 1}; grid-column: {@node.column + 1}">text</div>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(text).not.toContain('{@node.tier');
    expect(text).not.toContain('{@node.column');
    expect(tokens).toHaveLength(2);
  });
```

Also add a round-trip test inside the `describe('restoreSpindleTokens')` block:

```typescript
  it('round-trips expression interpolations in attributes', () => {
    const original = '<div style="grid-row: {@node.tier + 1}; grid-column: {@node.column + 1}">text</div>';
    const { text, tokens } = replaceSpindleTokens(original);
    const restored = restoreSpindleTokens(text, tokens);
    expect(restored).toBe(original);
  });
```

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `npx vitest run test/unit/placeholders.test.ts`
Expected: New expression interpolation tests FAIL (the regex doesn't match these patterns). Existing tests still PASS.

- [ ] **Step 3: Update `replaceSpindleTokens` to use scanner and remove `SPINDLE_TOKEN_REGEX`**

Replace the entire content of `src/plugins/format/placeholders.ts` — keeping `isInsideAttribute`, `PlaceholderResult`, SVG functions, `restoreSpindleTokens`, and the new scanner from Task 1. The only changes are: remove `SPINDLE_TOKEN_REGEX`, rewrite `replaceSpindleTokens`.

Delete `SPINDLE_TOKEN_REGEX` (line 8 in the original file).

Replace the `replaceSpindleTokens` function (lines 70–113) with:

```typescript
/**
 * Replace Spindle tokens with placeholders.
 * Uses <!--SP:N--> in HTML content and __SPN__ in attribute values.
 *
 * Lines that contain Spindle tokens but no HTML tags are replaced as a
 * single whole-line placeholder so Prettier cannot split them.
 */
export function replaceSpindleTokens(html: string): PlaceholderResult {
  const tokens: string[] = [];
  const lines = html.split('\n');
  const resultLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Scan for Spindle tokens
    const found = scanSpindleTokens(trimmed);

    if (found.length === 0) {
      resultLines.push(line);
      continue;
    }

    // Check if line has HTML tags after removing Spindle tokens
    let withoutSpindle = trimmed;
    for (let fi = found.length - 1; fi >= 0; fi--) {
      withoutSpindle = withoutSpindle.slice(0, found[fi].start) + withoutSpindle.slice(found[fi].end);
    }
    const hasHtml = HTML_TAG_REGEX.test(withoutSpindle);

    if (!hasHtml) {
      // Line has Spindle tokens but no HTML — replace entire line with one placeholder
      const idx = tokens.length;
      tokens.push(trimmed);
      const indent = line.match(/^(\s*)/)?.[1] ?? '';
      resultLines.push(`${indent}<!--SP:${idx}-->`);
    } else {
      // Line has both HTML and Spindle — replace individual tokens
      const indent = line.match(/^(\s*)/)?.[1] ?? '';
      const indentLen = indent.length;

      // Assign placeholder indices left-to-right
      const assignments = found.map(t => {
        const lineStart = t.start + indentLen;
        const idx = tokens.length;
        tokens.push(t.token);
        const placeholder = isInsideAttribute(line, lineStart)
          ? `__SP${idx}__`
          : `<!--SP:${idx}-->`;
        return { start: lineStart, end: t.end + indentLen, placeholder };
      });

      // Replace right-to-left to preserve offsets
      let replaced = line;
      for (let ai = assignments.length - 1; ai >= 0; ai--) {
        const a = assignments[ai];
        replaced = replaced.slice(0, a.start) + a.placeholder + replaced.slice(a.end);
      }
      resultLines.push(replaced);
    }
  }

  return { text: resultLines.join('\n'), tokens };
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx vitest run test/unit/placeholders.test.ts`
Expected: ALL tests PASS — both existing and new.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/format/placeholders.ts test/unit/placeholders.test.ts
git commit -m "fix: replace SPINDLE_TOKEN_REGEX with scanner in replaceSpindleTokens

Expression interpolations like {@node.tier + 1} and nested braces
like {@list[{$index}]} are now protected from Prettier reformatting.
Fixes #8."
```

---

### Task 3: Add integration test for issue #8

**Files:**
- Add test in: `test/unit/format.test.ts`

- [ ] **Step 1: Write the integration test**

Add this test inside the `describe('formatDocument')` block in `test/unit/format.test.ts`, after the SVG preservation tests (after line 419):

```typescript
  // -- Expression interpolation in style attributes (issue #8) ----------------

  it('does not split style attributes with expression interpolations', async () => {
    const input = [
      ':: Test [nobr]',
      '<div class="node-cell" style="grid-row: {@node.tier + 1}; grid-column: {@node.column + 1}">',
      '{@node.name}',
      '</div>',
      '',
    ].join('\n');
    const result = await formatDocument(input);
    // The style attribute must stay on one line — not split by Prettier
    const styleLine = result.split('\n').find(l => l.includes('style='));
    expect(styleLine).toBeDefined();
    expect(styleLine).toContain('{@node.tier + 1}');
    expect(styleLine).toContain('{@node.column + 1}');
  });

  it('is idempotent with expression interpolations in style attributes', async () => {
    const input = [
      ':: Test [nobr]',
      '<div class="node-cell" style="grid-row: {@node.tier + 1}; grid-column: {@node.column + 1}">',
      '{@node.name}',
      '</div>',
      '',
    ].join('\n');
    const first = await formatDocument(input);
    const second = await formatDocument(first);
    expect(second).toBe(first);
  });
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run test/unit/format.test.ts -t "expression interpolation"`
Expected: PASS — the placeholder fix from Task 2 protects these expressions.

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: ALL tests PASS.

Also run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add test/unit/format.test.ts
git commit -m "test: add integration tests for style attribute expression interpolations

Covers the exact scenario from issue #8 — expression interpolations in
style attributes must not be split across lines by the formatter."
```
