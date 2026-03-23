# Formatter Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded 5-macro formatter with a registry-aware, Prettier-powered pipeline that indents all container macros, formats HTML, JavaScript, and CSS inside Twee passages.

**Architecture:** The formatter becomes an async multi-pass pipeline: split into passages, classify each (script/stylesheet/normal), segment normal passages into regions (Spindle, HTML blocks, inline scripts), format each region with the appropriate tool (macro indentation for Spindle, Prettier for HTML/JS/CSS), then reassemble. The `formatDocument` function accepts optional `isBlock`/`isDedentingSubMacro` callbacks from the LSP macro registry, falling back to auto-detection from closing tags and `macro-supplements.json` for CLI/MCP use.

**Tech Stack:** TypeScript, Prettier (optional/dynamic), Vitest

**Spec:** `docs/superpowers/specs/2026-03-23-formatter-redesign.md`

---

### Task 1: Infrastructure Setup

**Files:**
- Modify: `package.json`
- Modify: `esbuild.config.ts`
- Modify: `src/macro-supplements.json`

- [ ] **Step 1: Add `prettier` as optional dependency**

In `package.json`, add to a new `optionalDependencies` section:

```json
"optionalDependencies": {
  "prettier": "^3.0.0"
}
```

- [ ] **Step 2: Add `prettier` to esbuild externals**

In `esbuild.config.ts`, add `'prettier'` to the `external` array:

```typescript
external: [
  '@rohal12/spindle',
  'vscode-languageserver',
  'vscode-languageserver-textdocument',
  'vscode-languageserver-protocol',
  'glob',
  'yaml',
  '@modelcontextprotocol/sdk',
  'zod',
  'prettier',
],
```

- [ ] **Step 3: Add `unless` to macro-supplements.json**

Add entry after the `widget` entry:

```json
"unless": {
  "name": "unless",
  "container": true,
  "description": "Conditionally displays its contents when the expression is falsy. The inverse of `{if}`.\n\nUsage:\n\n```\n{unless condition}\n  ...\n{/unless}\n```",
  "parameters": ["...text"]
}
```

- [ ] **Step 4: Install prettier and verify build**

Run: `npm install && node esbuild.config.ts`
Expected: clean install, build succeeds

- [ ] **Step 5: Run existing tests to confirm nothing broke**

Run: `npx vitest run`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add package.json esbuild.config.ts src/macro-supplements.json package-lock.json
git commit -m "chore: add prettier as optional dep, add unless to supplements"
```

---

### Task 2: Callback-Based Macro Indentation

Replace the hardcoded regex approach with a callback-based system that supports all container macros, dedenting sub-macros, and auto-detection from closing tags.

**Files:**
- Modify: `src/plugins/format.ts`
- Modify: `test/unit/format.test.ts`

- [ ] **Step 1: Write failing tests for new container macros and sub-macros**

Replace the contents of `test/unit/format.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import { formatDocument, formatRange } from '../../src/plugins/format.js';

describe('formatDocument', () => {
  // -- Existing behavior -------------------------------------------------

  it('indents content inside {if} by 2 spaces', async () => {
    const input = ':: Start\n{if $x}\n{set $y = 1}\n{/if}\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[2]).toBe('  {set $y = 1}');
  });

  it('handles nested indentation (2 and 4 spaces)', async () => {
    const input = ':: Start\n{if $x}\n{for @item range $list}\n{set $y = 1}\n{/for}\n{/if}\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[2]).toBe('  {for @item range $list}');
    expect(lines[3]).toBe('    {set $y = 1}');
    expect(lines[4]).toBe('  {/for}');
    expect(lines[5]).toBe('{/if}');
  });

  it('removes trailing whitespace from lines', async () => {
    const input = ':: Start   \nHello world   \n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[0]).toBe(':: Start');
    expect(lines[1]).toBe('Hello world');
  });

  it('ensures file ends with a single newline', async () => {
    const input = ':: Start\nHello world';
    const result = await formatDocument(input);
    expect(result.endsWith('\n')).toBe(true);
    expect(result.endsWith('\n\n')).toBe(false);
  });

  it('collapses multiple trailing newlines to one', async () => {
    const input = ':: Start\nHello world\n\n\n\n';
    const result = await formatDocument(input);
    expect(result).toBe(':: Start\nHello world\n');
  });

  it('normalizes passage headers with extra whitespace', async () => {
    const input = '::  Name  [tag]\nContent\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[0]).toBe(':: Name [tag]');
  });

  it('normalizes passage header with metadata braces', async () => {
    const input = '::  MyPassage  {"position": "100,200"}\nContent\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[0]).toBe(':: MyPassage {"position": "100,200"}');
  });

  it('returns already-formatted document unchanged', async () => {
    const input = ':: Start\n{if $x}\n  {set $y = 1}\n{/if}\n';
    const result = await formatDocument(input);
    expect(result).toBe(input);
  });

  it('resets indent level at passage boundaries', async () => {
    const input = ':: Passage1\n{if $x}\nContent\n\n:: Passage2\nMore content\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[5]).toBe('More content');
  });

  it('handles empty input', async () => {
    const result = await formatDocument('');
    expect(result).toBe('\n');
  });

  it('handles widget blocks', async () => {
    const input = ':: Widgets [widget]\n{widget "greet" @name}\nHello {@name}\n{/widget}\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[2]).toBe('  Hello {@name}');
    expect(lines[3]).toBe('{/widget}');
  });

  // -- New container macros ----------------------------------------------

  it('indents content inside {button}', async () => {
    const input = ':: Start\n{button "Click"}\n{set $x = 1}\n{/button}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  {set $x = 1}');
  });

  it('indents content inside {do}', async () => {
    const input = ':: Start\n{do}\n{set $x = 1}\n{/do}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  {set $x = 1}');
  });

  it('indents content inside {link}', async () => {
    const input = ':: Start\n{link "Go" "Next"}\n{set $x = 1}\n{/link}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  {set $x = 1}');
  });

  it('indents content inside {timed}', async () => {
    const input = ':: Start\n{timed 2s}\nFirst\n{/timed}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  First');
  });

  it('indents content inside {repeat}', async () => {
    const input = ':: Start\n{repeat 1s}\nContent\n{/repeat}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  Content');
  });

  it('indents content inside {type}', async () => {
    const input = ':: Start\n{type 30}\nContent\n{/type}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  Content');
  });

  it('indents content inside {dialog}', async () => {
    const input = ':: Start\n{dialog "Title"}\nContent\n{/dialog}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  Content');
  });

  it('indents content inside {nobr}', async () => {
    const input = ':: Start\n{nobr}\nContent\n{/nobr}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  Content');
  });

  it('indents content inside {span}', async () => {
    const input = ':: Start\n{span}\nContent\n{/span}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  Content');
  });

  it('indents content inside {listbox}', async () => {
    const input = ':: Start\n{listbox "$x"}\n{option "a"}\n{/listbox}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  {option "a"}');
  });

  it('indents content inside {cycle}', async () => {
    const input = ':: Start\n{cycle "$x"}\n{option "a"}\n{/cycle}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  {option "a"}');
  });

  it('indents content inside {unless}', async () => {
    const input = ':: Start\n{unless $x}\nContent\n{/unless}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  Content');
  });

  // -- Custom macros via auto-detection ----------------------------------

  it('auto-detects custom container macros from closing tags', async () => {
    const input = ':: Start\n{Section "Vitals"}\n{StatBar "HP" $hp 10}\n{/Section}\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[2]).toBe('  {StatBar "HP" $hp 10}');
    expect(lines[3]).toBe('{/Section}');
  });

  // -- Registry-backed isBlock callback ----------------------------------

  it('uses provided isBlock callback', async () => {
    const input = ':: Start\n{CustomBlock}\nContent\n{/CustomBlock}\n';
    const result = await formatDocument(input, {
      isBlock: (name) => name.toLowerCase() === 'customblock',
    });
    expect(result.split('\n')[2]).toBe('  Content');
  });

  // -- Dedenting sub-macros ----------------------------------------------

  it('dedents {else} to parent level', async () => {
    const input = ':: Start\n{if $x}\ncontent\n{else}\nfallback\n{/if}\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[1]).toBe('{if $x}');
    expect(lines[2]).toBe('  content');
    expect(lines[3]).toBe('{else}');
    expect(lines[4]).toBe('  fallback');
    expect(lines[5]).toBe('{/if}');
  });

  it('dedents {elseif} to parent level', async () => {
    const input = ':: Start\n{if $x}\na\n{elseif $y}\nb\n{else}\nc\n{/if}\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[2]).toBe('  a');
    expect(lines[3]).toBe('{elseif $y}');
    expect(lines[4]).toBe('  b');
    expect(lines[5]).toBe('{else}');
    expect(lines[6]).toBe('  c');
  });

  it('dedents {next} inside {timed} to parent level', async () => {
    const input = ':: Start\n{timed 2s}\nFirst\n{next 2s}\nSecond\n{next}\nThird\n{/timed}\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[1]).toBe('{timed 2s}');
    expect(lines[2]).toBe('  First');
    expect(lines[3]).toBe('{next 2s}');
    expect(lines[4]).toBe('  Second');
    expect(lines[5]).toBe('{next}');
    expect(lines[6]).toBe('  Third');
    expect(lines[7]).toBe('{/timed}');
  });

  it('dedents {case} and {default} to parent level inside {switch}', async () => {
    const input = ':: Start\n{switch $x}\n{case "a"}\nbranch a\n{default}\nfallback\n{/switch}\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[1]).toBe('{switch $x}');
    expect(lines[2]).toBe('{case "a"}');
    expect(lines[3]).toBe('  branch a');
    expect(lines[4]).toBe('{default}');
    expect(lines[5]).toBe('  fallback');
    expect(lines[6]).toBe('{/switch}');
  });

  // -- Macros with CSS prefix --------------------------------------------

  it('indents content inside macros with CSS prefix', async () => {
    const input = ':: Start\n{.red#alert if $danger}\nWarning!\n{/if}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  Warning!');
  });
});

describe('formatRange', () => {
  it('formats the full document (range is advisory)', async () => {
    const input = ':: Start\n{if $x}\n{set $y = 1}\n{/if}\n:: Next\nContent\n';
    const result = await formatRange(input, {
      start: { line: 1, character: 0 },
      end: { line: 3, character: 4 },
    });
    const lines = result.split('\n');
    expect(lines[2]).toBe('  {set $y = 1}');
    // Full document is formatted, including areas outside the range
    expect(lines[5]).toBe('Content');
  });

  it('normalizes passage headers even outside range', async () => {
    const input = '::  Start  [tag]\nContent\n';
    const result = await formatRange(input, {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 0 },
    });
    const lines = result.split('\n');
    expect(lines[0]).toBe(':: Start [tag]');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/format.test.ts`
Expected: FAIL — tests reference async `formatDocument` but it's still sync, and new macros aren't handled

- [ ] **Step 3: Rewrite `src/plugins/format.ts` — indentation engine**

Replace the hardcoded regex block detection with a callback-based system. Key changes:
- Add `FormatOptions` interface with `isBlock` and `isDedentingSubMacro`
- Build default `isBlock` by reading `macro-supplements.json` + scanning for `{/Name}` closing tags
- Default `isDedentingSubMacro` for `else`, `elseif`, `next`, `case`, `default`
- Make `formatDocument` async
- Make `formatRange` async (delegates to `formatDocument`)
- Update macro detection regex to match any `{Name ...}` / `{/Name}` pattern, not hardcoded names
- Add dedenting sub-macro handling

Replace the full content of `src/plugins/format.ts`:

```typescript
import type { Range } from '../core/types.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import supplements from '../macro-supplements.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormatOptions {
  /** Returns true if the named macro is a block/container macro. */
  isBlock?: (name: string) => boolean;
  /** Returns true for sub-macros that dedent to parent level (else, elseif, next). */
  isDedentingSubMacro?: (name: string) => boolean;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const PASSAGE_HEADER_REGEX = /^(::)\s+/;

/** Matches an opening macro tag, capturing optional CSS prefix and macro name. */
const MACRO_OPEN_REGEX = /^\{(?:[#.][a-zA-Z][\w-]*\s*)*([A-Za-z][\w-]*)\b/;

/** Matches a closing macro tag, capturing the macro name. */
const MACRO_CLOSE_REGEX = /^\{\/([A-Za-z][\w-]*)\b/;

/** Default dedenting sub-macros. */
const DEFAULT_DEDENTING = new Set(['else', 'elseif', 'next', 'case', 'default']);

// ---------------------------------------------------------------------------
// Default block detection from supplements + document scan
// ---------------------------------------------------------------------------

/** Container macro names from macro-supplements.json. */
function getSupplementContainers(): Set<string> {
  const containers = new Set<string>();
  for (const [key, entry] of Object.entries(supplements)) {
    if ((entry as { container?: boolean }).container) {
      containers.add(key.toLowerCase());
    }
  }
  return containers;
}

/** Scan a document for {/Name} closing tags and collect macro names. */
function detectContainersFromText(text: string): Set<string> {
  const found = new Set<string>();
  const re = /\{\/([A-Za-z][\w-]*)\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.add(m[1].toLowerCase());
  }
  return found;
}

/** Build an isBlock function from supplements + document auto-detection. */
function buildDefaultIsBlock(text: string): (name: string) => boolean {
  const containers = getSupplementContainers();
  for (const name of detectContainersFromText(text)) {
    containers.add(name);
  }
  return (name: string) => containers.has(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Core format functions
// ---------------------------------------------------------------------------

/**
 * Format an entire document.
 *
 * Rules:
 *  1. Indent content inside block macros by 2 spaces per nesting level
 *  2. Dedenting sub-macros (else, elseif, next) snap to parent indent level
 *  3. Remove trailing whitespace from each line
 *  4. Ensure file ends with a single newline
 *  5. Normalize passage headers: `::  Name  [tag]` -> `:: Name [tag]`
 */
export async function formatDocument(text: string, options?: FormatOptions): Promise<string> {
  const isBlock = options?.isBlock ?? buildDefaultIsBlock(text);
  const isDedenting = options?.isDedentingSubMacro
    ?? ((name: string) => DEFAULT_DEDENTING.has(name.toLowerCase()));

  const lines = text.split('\n');
  const result: string[] = [];
  let indentLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Remove trailing whitespace
    line = line.replace(/\s+$/, '');

    // Normalize passage headers
    if (PASSAGE_HEADER_REGEX.test(line)) {
      line = normalizePassageHeader(line);
      indentLevel = 0;
      result.push(line);
      continue;
    }

    const trimmed = line.trim();

    // Empty lines: preserve without whitespace
    if (trimmed === '') {
      result.push('');
      continue;
    }

    // Check for dedenting sub-macro (else, elseif, next)
    const dedentMatch = trimmed.match(MACRO_OPEN_REGEX);
    if (dedentMatch && isDedenting(dedentMatch[1])) {
      indentLevel = Math.max(0, indentLevel - 1);
      result.push(indentLevel > 0 ? '  '.repeat(indentLevel) + trimmed : trimmed);
      indentLevel++;
      continue;
    }

    // Check for closing tag
    const closeMatch = trimmed.match(MACRO_CLOSE_REGEX);
    if (closeMatch) {
      indentLevel = Math.max(0, indentLevel - 1);
    }

    // Apply indentation
    result.push(indentLevel > 0 ? '  '.repeat(indentLevel) + trimmed : trimmed);

    // Check for opening container tag
    const openMatch = trimmed.match(MACRO_OPEN_REGEX);
    if (openMatch && isBlock(openMatch[1])) {
      indentLevel++;
    }
  }

  // Ensure file ends with a single newline
  let output = result.join('\n');
  output = output.replace(/\n*$/, '\n');

  return output;
}

/**
 * Format a specific range within a document.
 * Formats the full document — Prettier can change line counts, making
 * line-index slicing unreliable. The LSP plugin already replaces the
 * entire document content, so this is safe and correct.
 */
export async function formatRange(text: string, _range: Range, options?: FormatOptions): Promise<string> {
  return formatDocument(text, options);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePassageHeader(line: string): string {
  const headerMatch = line.match(/^::\s+(.*)/);
  if (!headerMatch) return line;

  const rest = headerMatch[1];
  const bracketIdx = rest.indexOf('[');
  const braceIdx = rest.indexOf('{');

  let name: string;
  let suffix = '';

  if (bracketIdx !== -1 && (braceIdx === -1 || bracketIdx < braceIdx)) {
    name = rest.substring(0, bracketIdx).trim();
    suffix = ' ' + rest.substring(bracketIdx).trim();
  } else if (braceIdx !== -1) {
    name = rest.substring(0, braceIdx).trim();
    suffix = ' ' + rest.substring(braceIdx).trim();
  } else {
    name = rest.trim();
  }

  return `:: ${name}${suffix}`;
}

// ---------------------------------------------------------------------------
// Plugin wrapper (LSP integration)
// ---------------------------------------------------------------------------

export const formatPlugin: SpindlePlugin = {
  id: 'format',
  capabilities: {
    documentFormattingProvider: true,
    documentRangeFormattingProvider: true,
  },
  initialize(ctx: PluginContext) {
    const formatOpts: FormatOptions = {
      isBlock: (name) => ctx.workspace.macros.isBlock(name),
      isDedentingSubMacro: (name) => DEFAULT_DEDENTING.has(name.toLowerCase()),
    };

    ctx.connection.onDocumentFormatting(async (params) => {
      const text = ctx.workspace.documents.getText(params.textDocument.uri);
      if (text === undefined) return [];

      const formatted = await formatDocument(text, formatOpts);
      if (formatted === text) return [];

      const lines = text.split('\n');
      return [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: lines.length - 1, character: lines[lines.length - 1].length },
        },
        newText: formatted,
      }];
    });

    ctx.connection.onDocumentRangeFormatting(async (params) => {
      const text = ctx.workspace.documents.getText(params.textDocument.uri);
      if (text === undefined) return [];

      const range: Range = {
        start: { line: params.range.start.line, character: params.range.start.character },
        end: { line: params.range.end.line, character: params.range.end.character },
      };

      const formatted = await formatRange(text, range, formatOpts);
      if (formatted === text) return [];

      const lines = text.split('\n');
      return [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: lines.length - 1, character: lines[lines.length - 1].length },
        },
        newText: formatted,
      }];
    });
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/format.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Update CLI for async formatDocument**

In `src/cli/format.ts`, change the `formatDocument` call to `await`:

```typescript
// Line 68: change from
const formatted = formatDocument(text);
// to
const formatted = await formatDocument(text);
```

- [ ] **Step 6: Update MCP server for async formatDocument**

In `src/mcp/server.ts`, change both `formatDocument` calls to `await`:

```typescript
// In spindle_format handler (~line 191):
const result = await formatDocument(text);

// In spindle_format_check handler (~line 235):
const result = await formatDocument(text);
```

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: all tests PASS (unit + integration)

- [ ] **Step 8: Commit**

```bash
git add src/plugins/format.ts src/cli/format.ts src/mcp/server.ts test/unit/format.test.ts
git commit -m "feat: callback-based macro indentation with auto-detection and sub-macro dedenting"
```

---

### Task 3: Prettier Wrapper with Dynamic Import

Add a wrapper module that dynamically imports Prettier and provides format functions for JS, CSS, and HTML with graceful fallback.

**Files:**
- Create: `src/plugins/format/prettier-bridge.ts`
- Create: `test/unit/prettier-bridge.test.ts`

- [ ] **Step 1: Write failing tests for the Prettier bridge**

Create `test/unit/prettier-bridge.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { formatJS, formatCSS, formatHTML, isPrettierAvailable } from '../../src/plugins/format/prettier-bridge.js';

describe('prettier-bridge', () => {
  it('isPrettierAvailable returns true when prettier is installed', async () => {
    expect(await isPrettierAvailable()).toBe(true);
  });

  it('formats JavaScript code', async () => {
    const input = 'const   x=1;const y = 2';
    const result = await formatJS(input);
    expect(result).toContain('const x = 1;');
    expect(result).toContain('const y = 2;');
  });

  it('formats CSS code', async () => {
    const input = '.foo{color:red;display:block}';
    const result = await formatCSS(input);
    expect(result).toContain('color: red;');
    expect(result).toContain('display: block;');
  });

  it('formats HTML code', async () => {
    const input = '<div><span>text</span><p>para</p></div>';
    const result = await formatHTML(input);
    // Prettier should add newlines/indentation
    expect(result).toContain('<div>');
    expect(result).toContain('  <span>');
  });

  it('returns input unchanged on malformed JS', async () => {
    const input = 'const x = {{{';
    const result = await formatJS(input);
    expect(result).toBe(input);
  });

  it('returns input unchanged on malformed CSS', async () => {
    const input = '.foo { color: }}}';
    const result = await formatCSS(input);
    expect(result).toBe(input);
  });

  it('returns input unchanged on malformed HTML', async () => {
    const input = '<div><<<<>>>';
    const result = await formatHTML(input);
    expect(result).toBe(input);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/prettier-bridge.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Create the Prettier bridge module**

Create directory and file `src/plugins/format/prettier-bridge.ts`:

```typescript
type Prettier = typeof import('prettier');

let prettier: Prettier | null = null;
let prettierLoaded = false;

async function loadPrettier(): Promise<Prettier | null> {
  if (prettierLoaded) return prettier;
  prettierLoaded = true;
  try {
    prettier = await import('prettier');
  } catch {
    prettier = null;
  }
  return prettier;
}

export async function isPrettierAvailable(): Promise<boolean> {
  return (await loadPrettier()) !== null;
}

async function getBaseConfig(): Promise<Record<string, unknown>> {
  const p = await loadPrettier();
  if (!p) return {};
  try {
    const resolved = await p.resolveConfig(process.cwd());
    return { tabWidth: 2, ...(resolved ?? {}) };
  } catch {
    return { tabWidth: 2 };
  }
}

export async function formatJS(code: string): Promise<string> {
  const p = await loadPrettier();
  if (!p) return code;
  try {
    const config = await getBaseConfig();
    const result = await p.format(code, { ...config, parser: 'babel' });
    return result;
  } catch {
    return code;
  }
}

export async function formatCSS(code: string): Promise<string> {
  const p = await loadPrettier();
  if (!p) return code;
  try {
    const config = await getBaseConfig();
    const result = await p.format(code, { ...config, parser: 'css' });
    return result;
  } catch {
    return code;
  }
}

export async function formatHTML(code: string): Promise<string> {
  const p = await loadPrettier();
  if (!p) return code;
  try {
    const config = await getBaseConfig();
    const result = await p.format(code, {
      ...config,
      parser: 'html',
      htmlWhitespaceSensitivity: 'ignore',
    });
    return result;
  } catch {
    return code;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/prettier-bridge.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/format/prettier-bridge.ts test/unit/prettier-bridge.test.ts
git commit -m "feat: prettier bridge with dynamic import and graceful fallback"
```

---

### Task 4: Placeholder Substitution for HTML

Build the system that replaces Spindle tokens with placeholders before Prettier formats HTML, and restores them after.

**Files:**
- Create: `src/plugins/format/placeholders.ts`
- Create: `test/unit/placeholders.test.ts`

- [ ] **Step 1: Write failing tests for placeholder substitution**

Create `test/unit/placeholders.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { replaceSpindleTokens, restoreSpindleTokens } from '../../src/plugins/format/placeholders.js';

describe('replaceSpindleTokens', () => {
  it('replaces macro calls with comment placeholders', () => {
    const input = '<div>{set $x = 1}</div>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(text).not.toContain('{set $x = 1}');
    expect(text).toContain('<!--SP:0-->');
    expect(tokens[0]).toBe('{set $x = 1}');
  });

  it('replaces closing macros', () => {
    const input = '<div>{if $x}hello{/if}</div>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(text).not.toContain('{if $x}');
    expect(text).not.toContain('{/if}');
    expect(tokens).toHaveLength(2);
  });

  it('replaces variable displays', () => {
    const input = '<span>{$playerName}</span>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(text).not.toContain('{$playerName}');
    expect(tokens[0]).toBe('{$playerName}');
  });

  it('replaces Spindle links', () => {
    const input = '<div>[[Home]]</div>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(text).not.toContain('[[Home]]');
    expect(tokens[0]).toBe('[[Home]]');
  });

  it('uses attribute-safe placeholders inside attribute values', () => {
    const input = '<div class="{$className}">text</div>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(text).toContain('__SP0__');
    expect(text).not.toContain('<!--');
    expect(tokens[0]).toBe('{$className}');
  });

  it('handles multiple tokens', () => {
    const input = '<div>{$a}</div><span>{$b}</span>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(tokens).toHaveLength(2);
    expect(text).toContain('<!--SP:0-->');
    expect(text).toContain('<!--SP:1-->');
  });
});

describe('restoreSpindleTokens', () => {
  it('round-trips tokens back to original', () => {
    const original = '<div>{$playerName}</div>';
    const { text, tokens } = replaceSpindleTokens(original);
    const restored = restoreSpindleTokens(text, tokens);
    expect(restored).toBe(original);
  });

  it('round-trips attribute tokens', () => {
    const original = '<div class="{$cls}">text</div>';
    const { text, tokens } = replaceSpindleTokens(original);
    const restored = restoreSpindleTokens(text, tokens);
    expect(restored).toBe(original);
  });

  it('round-trips multiple mixed tokens', () => {
    const original = '<div class="{$cls}">{$name} [[Home]]</div>';
    const { text, tokens } = replaceSpindleTokens(original);
    const restored = restoreSpindleTokens(text, tokens);
    expect(restored).toBe(original);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/placeholders.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement the placeholders module**

Create `src/plugins/format/placeholders.ts`:

```typescript
/**
 * Regex matching Spindle tokens in HTML:
 * - {macroName ...} or {/macroName}
 * - {$variable} or {_variable} or {@variable} (with optional dot paths)
 * - [[links]]
 */
const SPINDLE_TOKEN_REGEX = /(?:\{\/[A-Za-z][\w-]*\s*\}|\{(?:[#.][a-zA-Z][\w-]*\s*)*[A-Za-z][\w-]*(?:\s+(?:[^}]|\}(?=[^}]))*?)?\}|\{[$_@][a-zA-Z][\w.]*\}|\[\[(?:[^\]]*)\]\])/g;

/**
 * Check if a position in the string is inside an HTML attribute value.
 * Simplified heuristic: look backwards for `="` pattern without a closing `"`.
 */
function isInsideAttribute(text: string, pos: number): boolean {
  // Walk backwards from pos looking for quote context
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < pos; i++) {
    const ch = text[i];
    if (!inQuote && (ch === '"' || ch === "'") && i > 0 && text[i - 1] === '=') {
      inQuote = true;
      quoteChar = ch;
    } else if (inQuote && ch === quoteChar) {
      inQuote = false;
    }
  }
  return inQuote;
}

export interface PlaceholderResult {
  text: string;
  tokens: string[];
}

/**
 * Replace Spindle tokens with placeholders.
 * Uses <!--SP:N--> in HTML content and __SPN__ in attribute values.
 */
export function replaceSpindleTokens(html: string): PlaceholderResult {
  const tokens: string[] = [];
  const text = html.replace(SPINDLE_TOKEN_REGEX, (match, offset: number) => {
    const idx = tokens.length;
    tokens.push(match);
    if (isInsideAttribute(html, offset)) {
      return `__SP${idx}__`;
    }
    return `<!--SP:${idx}-->`;
  });
  return { text, tokens };
}

/**
 * Restore original Spindle tokens from placeholders.
 */
export function restoreSpindleTokens(text: string, tokens: string[]): string {
  let result = text;
  for (let i = 0; i < tokens.length; i++) {
    result = result.replace(`<!--SP:${i}-->`, tokens[i]);
    result = result.replace(`__SP${i}__`, tokens[i]);
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/placeholders.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/format/placeholders.ts test/unit/placeholders.test.ts
git commit -m "feat: spindle token placeholder substitution for HTML formatting"
```

---

### Task 5: Passage Segmentation

Add passage-type detection (script, stylesheet, normal) and within normal passages, identify HTML blocks and inline `<script>` regions.

**Files:**
- Create: `src/plugins/format/segment.ts`
- Create: `test/unit/segment.test.ts`

- [ ] **Step 1: Write failing tests for segmentation**

Create `test/unit/segment.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { splitPassages, classifyPassage, segmentRegions } from '../../src/plugins/format/segment.js';

describe('splitPassages', () => {
  it('splits document into passages', () => {
    const input = ':: Start\nContent\n\n:: Next [tag]\nMore\n';
    const passages = splitPassages(input);
    expect(passages).toHaveLength(2);
    expect(passages[0].header).toBe(':: Start');
    expect(passages[0].body).toBe('Content\n');
    expect(passages[1].header).toBe(':: Next [tag]');
    expect(passages[1].body).toBe('More\n');
  });

  it('handles document with no passage headers', () => {
    const input = 'Just some text\n';
    const passages = splitPassages(input);
    expect(passages).toHaveLength(1);
    expect(passages[0].header).toBe('');
    expect(passages[0].body).toBe('Just some text\n');
  });
});

describe('classifyPassage', () => {
  it('classifies script passages', () => {
    expect(classifyPassage(':: Init [script]')).toBe('script');
  });

  it('classifies stylesheet passages', () => {
    expect(classifyPassage(':: Styles [stylesheet]')).toBe('stylesheet');
  });

  it('classifies normal passages', () => {
    expect(classifyPassage(':: Start')).toBe('normal');
    expect(classifyPassage(':: Start [widget]')).toBe('normal');
  });

  it('handles case-insensitive tags', () => {
    expect(classifyPassage(':: Init [Script]')).toBe('script');
    expect(classifyPassage(':: Styles [Stylesheet]')).toBe('stylesheet');
  });
});

describe('segmentRegions', () => {
  it('classifies plain Spindle lines as spindle regions', () => {
    const regions = segmentRegions('{if $x}\ncontent\n{/if}\n');
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe('spindle');
  });

  it('detects inline <script> blocks', () => {
    const input = 'text\n<script>\nconst x = 1;\n</script>\nmore\n';
    const regions = segmentRegions(input);
    const types = regions.map(r => r.type);
    expect(types).toContain('script');
    expect(types.filter(t => t === 'spindle')).toHaveLength(2);
  });

  it('detects multi-line HTML blocks', () => {
    const input = '{if $x}\n<div>\n  <span>text</span>\n</div>\n{/if}\n';
    const regions = segmentRegions(input);
    const types = regions.map(r => r.type);
    expect(types).toContain('html');
  });

  it('does NOT treat single-line inline HTML as HTML block', () => {
    const input = 'text <em>bold</em> more\n';
    const regions = segmentRegions(input);
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe('spindle');
  });

  it('does NOT treat single-line HTML tags starting a line as HTML block', () => {
    const input = '<br>\n{set $x = 1}\n';
    const regions = segmentRegions(input);
    // Single <br> is a void element on its own line — not a multi-line block
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe('spindle');
  });

  it('detects multi-line HTML starting with non-void tag', () => {
    const input = '<div class="foo">\n  <p>hello</p>\n</div>\n';
    const regions = segmentRegions(input);
    expect(regions[0].type).toBe('html');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/segment.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement the segmentation module**

Create `src/plugins/format/segment.ts`:

```typescript
export interface Passage {
  header: string;
  body: string;
  /** Line index in the original document where the header is. */
  startLine: number;
}

export interface Region {
  type: 'spindle' | 'html' | 'script';
  lines: string[];
}

const PASSAGE_HEADER_REGEX = /^::\s+/;
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Split a Twee document into passages by `::` headers.
 */
export function splitPassages(text: string): Passage[] {
  const lines = text.split('\n');
  // Remove trailing empty string from split (artifact of trailing \n)
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const passages: Passage[] = [];
  let currentHeader = '';
  let bodyLines: string[] = [];
  let startLine = 0;

  function pushPassage() {
    if (currentHeader || bodyLines.length > 0) {
      passages.push({
        header: currentHeader,
        body: bodyLines.join('\n') + (bodyLines.length > 0 ? '\n' : ''),
        startLine,
      });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (PASSAGE_HEADER_REGEX.test(lines[i])) {
      pushPassage();
      currentHeader = lines[i];
      bodyLines = [];
      startLine = i;
    } else {
      bodyLines.push(lines[i]);
    }
  }

  pushPassage();
  return passages;
}

/**
 * Classify a passage by its tags.
 */
export function classifyPassage(header: string): 'script' | 'stylesheet' | 'normal' {
  const tagMatch = header.match(/\[([^\]]*)\]/g);
  if (!tagMatch) return 'normal';
  const tags = tagMatch.map(t => t.slice(1, -1).trim().toLowerCase());
  if (tags.includes('script')) return 'script';
  if (tags.includes('stylesheet')) return 'stylesheet';
  return 'normal';
}

/**
 * Segment a passage body into regions: spindle (markdown/macros), html blocks, script blocks.
 */
export function segmentRegions(body: string): Region[] {
  const lines = body.split('\n');
  // Remove trailing empty line from split
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length === 0) return [];

  const regions: Region[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect <script> blocks
    if (/^<script(\s|>)/i.test(trimmed)) {
      const scriptLines: string[] = [line];
      i++;
      while (i < lines.length && !/<\/script>/i.test(lines[i])) {
        scriptLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        scriptLines.push(lines[i]); // closing </script>
        i++;
      }
      regions.push({ type: 'script', lines: scriptLines });
      continue;
    }

    // Detect multi-line HTML blocks
    if (/^<([a-zA-Z][\w-]*)/.test(trimmed)) {
      const tagMatch = trimmed.match(/^<([a-zA-Z][\w-]*)/);
      const tagName = tagMatch![1].toLowerCase();

      // Skip void elements on their own line — not a multi-line block
      if (VOID_ELEMENTS.has(tagName) && !lines[i + 1]?.trim().startsWith('<')) {
        // Treat as spindle line
        pushSpindleLine(regions, line);
        i++;
        continue;
      }

      // Check if this is truly multi-line: does the tag close on the same line?
      const selfClosing = new RegExp(`</${tagName}\\s*>`, 'i');
      if (selfClosing.test(trimmed)) {
        // Single-line HTML — treat as spindle
        pushSpindleLine(regions, line);
        i++;
        continue;
      }

      // Multi-line HTML block
      const htmlLines: string[] = [line];
      let depth = 1;
      i++;
      while (i < lines.length && depth > 0) {
        htmlLines.push(lines[i]);
        const opens = (lines[i].match(new RegExp(`<${tagName}[\\s>]`, 'gi')) ?? []).length;
        const closes = (lines[i].match(new RegExp(`</${tagName}\\s*>`, 'gi')) ?? []).length;
        depth += opens - closes;
        i++;
      }
      regions.push({ type: 'html', lines: htmlLines });
      continue;
    }

    // Default: spindle/markdown line
    pushSpindleLine(regions, line);
    i++;
  }

  return regions;
}

/** Append a line to the last spindle region, or create a new one. */
function pushSpindleLine(regions: Region[], line: string): void {
  const last = regions[regions.length - 1];
  if (last?.type === 'spindle') {
    last.lines.push(line);
  } else {
    regions.push({ type: 'spindle', lines: [line] });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/segment.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/format/segment.ts test/unit/segment.test.ts
git commit -m "feat: passage splitting and region segmentation for formatter pipeline"
```

---

### Task 6: Wire Pipeline — Format HTML, JS, CSS Regions

Integrate segmentation, Prettier bridge, and placeholders into the main `formatDocument` pipeline.

**Files:**
- Modify: `src/plugins/format.ts`
- Modify: `test/unit/format.test.ts`

- [ ] **Step 1: Add pipeline tests for JS/CSS/HTML formatting**

Append these tests to `test/unit/format.test.ts` inside the `formatDocument` describe block:

```typescript
  // -- Script passage formatting ------------------------------------------

  it('formats JavaScript in [script]-tagged passages', async () => {
    const input = ':: Init [script]\nconst   x=1;const y = 2\n';
    const result = await formatDocument(input);
    expect(result).toContain('const x = 1;');
  });

  it('leaves malformed JS in [script] passages as-is', async () => {
    const input = ':: Init [script]\nconst x = {{{\n';
    const result = await formatDocument(input);
    expect(result).toContain('const x = {{{');
  });

  // -- Stylesheet passage formatting -------------------------------------

  it('formats CSS in [stylesheet]-tagged passages', async () => {
    const input = ':: Styles [stylesheet]\n.foo{color:red;display:block}\n';
    const result = await formatDocument(input);
    expect(result).toContain('color: red;');
  });

  // -- Inline <script> formatting ----------------------------------------

  it('formats JavaScript inside <script> tags', async () => {
    const input = ':: Start\n<script>\nconst   x=1\n</script>\n';
    const result = await formatDocument(input);
    expect(result).toContain('const x = 1;');
  });

  // -- HTML block formatting ---------------------------------------------

  it('formats multi-line HTML blocks', async () => {
    const input = ':: Start\n<div><span>text</span><p>para</p></div>\n';
    // Single-line HTML — should NOT be sent to Prettier
    const result = await formatDocument(input);
    expect(result).toContain('<div>');
  });

  it('formats multi-line HTML and preserves Spindle tokens', async () => {
    const input = ':: Start\n<div>\n<span>{$name}</span>\n</div>\n';
    const result = await formatDocument(input);
    expect(result).toContain('{$name}');
  });

  it('preserves Spindle links inside HTML', async () => {
    const input = ':: Start\n<div>\n<span>[[Home]]</span>\n</div>\n';
    const result = await formatDocument(input);
    expect(result).toContain('[[Home]]');
  });

  // -- Idempotency -------------------------------------------------------

  it('is idempotent — double formatting produces same result', async () => {
    const input = ':: Start\n{if $x}\n{Section "V"}\ncontent\n{/Section}\n{else}\nfallback\n{/if}\n';
    const first = await formatDocument(input);
    const second = await formatDocument(first);
    expect(second).toBe(first);
  });

  it('is idempotent with HTML blocks', async () => {
    const input = ':: Start\n<div>\n<span>{$name}</span>\n</div>\n';
    const first = await formatDocument(input);
    const second = await formatDocument(first);
    expect(second).toBe(first);
  });

  it('is idempotent with script passages', async () => {
    const input = ':: Init [script]\nconst   x=1;const y = 2\n';
    const first = await formatDocument(input);
    const second = await formatDocument(first);
    expect(second).toBe(first);
  });
```

- [ ] **Step 2: Run tests to verify new ones fail**

Run: `npx vitest run test/unit/format.test.ts`
Expected: new tests FAIL (JS/CSS/HTML not formatted yet), existing tests still PASS

- [ ] **Step 3: Integrate pipeline into `formatDocument`**

Update `src/plugins/format.ts` to import the segmentation and Prettier modules, and add the pipeline logic. The key changes to `formatDocument`:

1. After splitting lines, detect passage headers and classify each passage
2. For `script` passages: format body as JS via Prettier bridge
3. For `stylesheet` passages: format body as CSS via Prettier bridge
4. For `normal` passages: segment body into regions, format HTML/script regions, then apply macro indentation to spindle regions
5. Reassemble

The full updated `formatDocument` function (replace the existing one in `src/plugins/format.ts`):

```typescript
import { splitPassages, classifyPassage, segmentRegions } from './format/segment.js';
import { formatJS, formatCSS, formatHTML as formatHTMLPrettier } from './format/prettier-bridge.js';
import { replaceSpindleTokens, restoreSpindleTokens } from './format/placeholders.js';
```

Add these imports at the top, then replace `formatDocument`:

```typescript
export async function formatDocument(text: string, options?: FormatOptions): Promise<string> {
  const isBlock = options?.isBlock ?? buildDefaultIsBlock(text);
  const isDedenting = options?.isDedentingSubMacro
    ?? ((name: string) => DEFAULT_DEDENTING.has(name.toLowerCase()));

  const passages = splitPassages(text);
  const resultLines: string[] = [];

  for (const passage of passages) {
    // Normalize and emit passage header
    if (passage.header) {
      const header = PASSAGE_HEADER_REGEX.test(passage.header)
        ? normalizePassageHeader(passage.header)
        : passage.header;
      resultLines.push(header);
    }

    const kind = classifyPassage(passage.header);

    if (kind === 'script') {
      // Format entire body as JS
      const formatted = await formatJS(passage.body.trim());
      resultLines.push(formatted.trim());
      continue;
    }

    if (kind === 'stylesheet') {
      // Format entire body as CSS
      const formatted = await formatCSS(passage.body.trim());
      resultLines.push(formatted.trim());
      continue;
    }

    // Normal passage: segment into regions
    const regions = segmentRegions(passage.body);

    for (const region of regions) {
      if (region.type === 'script') {
        // Inline <script> block — format JS content between tags
        const firstLine = region.lines[0];
        const lastLine = region.lines[region.lines.length - 1];
        const innerLines = region.lines.slice(1, region.lines.length - 1);
        const innerCode = innerLines.join('\n');
        const formatted = await formatJS(innerCode.trim());
        resultLines.push(firstLine);
        if (formatted.trim()) {
          for (const fLine of formatted.trim().split('\n')) {
            resultLines.push('  ' + fLine);
          }
        }
        resultLines.push(lastLine);
        continue;
      }

      if (region.type === 'html') {
        // HTML block — placeholder substitution + Prettier
        const htmlText = region.lines.join('\n');
        const { text: placeholdered, tokens } = replaceSpindleTokens(htmlText);
        const formatted = await formatHTMLPrettier(placeholdered);
        const restored = restoreSpindleTokens(formatted.trim(), tokens);
        for (const fLine of restored.split('\n')) {
          resultLines.push(fLine);
        }
        continue;
      }

      // Spindle/markdown region — apply macro indentation
      const indented = indentMacros(region.lines, isBlock, isDedenting);
      resultLines.push(...indented);
    }
  }

  // Strip trailing whitespace from all lines (covers HTML/JS/CSS output too)
  // and ensure file ends with a single newline
  let output = resultLines.map(l => l.replace(/\s+$/, '')).join('\n');
  output = output.replace(/\n*$/, '\n');

  return output;
}
```

Extract the current indentation loop into a helper function `indentMacros`:

```typescript
function indentMacros(
  lines: string[],
  isBlock: (name: string) => boolean,
  isDedenting: (name: string) => boolean,
): string[] {
  const result: string[] = [];
  let indentLevel = 0;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();

    if (trimmed === '') {
      result.push('');
      continue;
    }

    // Dedenting sub-macros
    const dedentMatch = trimmed.match(MACRO_OPEN_REGEX);
    if (dedentMatch && isDedenting(dedentMatch[1])) {
      indentLevel = Math.max(0, indentLevel - 1);
      result.push(indentLevel > 0 ? '  '.repeat(indentLevel) + trimmed : trimmed);
      indentLevel++;
      continue;
    }

    // Closing tags
    const closeMatch = trimmed.match(MACRO_CLOSE_REGEX);
    if (closeMatch) {
      indentLevel = Math.max(0, indentLevel - 1);
    }

    result.push(indentLevel > 0 ? '  '.repeat(indentLevel) + trimmed : trimmed);

    // Opening container tags
    const openMatch = trimmed.match(MACRO_OPEN_REGEX);
    if (openMatch && isBlock(openMatch[1])) {
      indentLevel++;
    }
  }

  return result;
}
```

Update `formatRange` — it already delegates to `formatDocument`, so it just needs to stay async (already done in Task 2).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/format.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Run full test suite including integration tests**

Run: `npx vitest run`
Expected: all tests PASS. Integration tests in `test/integration/cli-format.test.ts` should still work since CLI already awaits the async function (from Task 2).

- [ ] **Step 6: Commit**

```bash
git add src/plugins/format.ts test/unit/format.test.ts
git commit -m "feat: full formatting pipeline with HTML, JS, CSS via Prettier"
```

---

### Task 7: Integration Tests & Final Verification

Update integration tests for the new async behavior and add end-to-end tests covering the full pipeline.

**Files:**
- Modify: `test/integration/cli-format.test.ts`

- [ ] **Step 1: Update and extend integration tests**

Update `test/integration/cli-format.test.ts` — existing tests should already work with the async changes. Add new integration tests:

```typescript
  it('formats container macros beyond if/for/switch', async () => {
    const filePath = join(tmpDir, 'test.tw');
    writeFileSync(filePath, ':: Start\n{button "Go"}\n{set $x = 1}\n{/button}');

    const { exitCode } = await captureStdout(() => runFormat([filePath]));
    expect(exitCode).toBe(0);

    const result = readFileSync(filePath, 'utf-8');
    expect(result).toContain('  {set $x = 1}');
  });

  it('formats custom container macros auto-detected from closing tags', async () => {
    const filePath = join(tmpDir, 'test.tw');
    writeFileSync(filePath, ':: Start\n{Section "V"}\ncontent\n{/Section}');

    const { exitCode } = await captureStdout(() => runFormat([filePath]));
    expect(exitCode).toBe(0);

    const result = readFileSync(filePath, 'utf-8');
    expect(result).toContain('  content');
  });

  it('dedents {else} to parent level', async () => {
    const filePath = join(tmpDir, 'test.tw');
    writeFileSync(filePath, ':: Start\n{if $x}\na\n{else}\nb\n{/if}');

    const { exitCode } = await captureStdout(() => runFormat([filePath]));
    expect(exitCode).toBe(0);

    const result = readFileSync(filePath, 'utf-8');
    const lines = result.split('\n');
    expect(lines[3]).toBe('{else}');
    expect(lines[4]).toBe('  b');
  });
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: all tests PASS

- [ ] **Step 3: Run build to verify everything compiles**

Run: `node esbuild.config.ts`
Expected: build succeeds without errors

- [ ] **Step 4: Manual smoke test with the CLI**

Create a test file and run the formatter:

```bash
cat > /tmp/test-format.tw << 'EOF'
:: Start
{if $x}
{Section "Vitals"}
{StatBar "Fatigue" $pc.attributes.fatigue 10 "fill-amber"}
{StatBar "Hunger" $pc.attributes.hunger 10 "fill-amber"}
{/Section}
{else}
No vitals
{/if}

:: Styles [stylesheet]
.foo{color:red;display:block}

:: Init [script]
const   x=1;const y = 2
EOF

node dist/bin.js format /tmp/test-format.tw && cat /tmp/test-format.tw
```

Expected output should show:
- `{Section}` content indented
- `{else}` at same level as `{if}`
- CSS formatted with proper spacing
- JS formatted with proper spacing

- [ ] **Step 5: Commit**

```bash
git add test/integration/cli-format.test.ts
git commit -m "test: integration tests for expanded container macros, sub-macro dedenting"
```
