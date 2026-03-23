# Formatter Redesign: Container Macros, HTML & JavaScript Formatting

## Problem

The current formatter uses hardcoded regexes for 5 block macros (`if`, `for`, `switch`, `unless`, `widget`). It misses all other container macros (`button`, `do`, `link`, `timed`, `repeat`, `type`, `listbox`, `cycle`, `dialog`, `nobr`, `span`, and any user-defined container macros). It also does not format HTML or JavaScript that appears inside passages.

## Goals

1. Indent content inside **all** container macros, including custom ones
2. Pretty-format **HTML** blocks inside passages using Prettier
3. Pretty-format **JavaScript** inside `<script>` tags and `[script]`-tagged passages using Prettier
4. Pretty-format **CSS** inside `[stylesheet]`-tagged passages using Prettier
5. Maintain standalone operation for CLI/MCP (no workspace dependency required)

## Architecture

The formatter becomes a multi-pass pipeline operating on each passage:

```
Input text
  -> Split into passages
  -> Per passage:
     1. Identify passage type (script / stylesheet / normal)
     2. If script passage: format entire body as JS via Prettier
     3. If stylesheet passage: format entire body as CSS via Prettier
     4. If normal passage:
        a. Segment into regions (spindle lines, HTML blocks, inline <script> blocks)
        b. Format <script> block contents as JS via Prettier
        c. Format HTML blocks via Prettier (with Spindle placeholder substitution)
        d. Apply container macro indentation (Spindle/markdown regions only)
  -> Reassemble
  -> Finalize (trailing whitespace, single trailing newline, passage header normalization)
```

Container macro indentation applies **only** to Spindle/markdown regions. HTML blocks and script blocks are formatted entirely by Prettier and are not re-indented by the macro indentation pass.

## API Change

### `formatDocument` signature

```typescript
export interface FormatOptions {
  /** Returns true if the named macro is a block/container macro. */
  isBlock?: (name: string) => boolean;
  /** Returns true for sub-macros that dedent to parent level (else, elseif, next). */
  isDedentingSubMacro?: (name: string) => boolean;
}

export async function formatDocument(text: string, options?: FormatOptions): Promise<string>
```

The function becomes `async` because Prettier's `format()` is async.

### `formatRange`

`formatRange` also becomes async. Implementation strategy: format the full document, then compute and return only the edits that fall within the requested range. This avoids complexity around regions that straddle range boundaries.

```typescript
export async function formatRange(text: string, range: Range, options?: FormatOptions): Promise<string>
```

### Callers

- **LSP plugin**: passes `{ isBlock: macros.isBlock.bind(macros), isDedentingSubMacro: ... }` from `ctx.workspace.macros`
- **CLI**: no options — uses auto-detection (see below)
- **MCP server**: no options — uses auto-detection

### Fallback: auto-detection (no registry)

When `isBlock` is not provided, the formatter:

1. Loads a **default set** of known container macro names from `macro-supplements.json` (all entries with `"container": true`)
2. Scans the document for `{/Name}` closing tags and adds those names to the container set
3. Uses a **hardcoded default set** of dedenting sub-macros: `else`, `elseif`, `next`

This handles custom macros like `{Section}...{/Section}` automatically — the closing tag is evidence enough.

**Note:** `unless` is in the current hardcoded regex but not in `macro-supplements.json`. It must be added to supplements (with `"container": true`) or it will regress in CLI/MCP mode. If the builtin registry from `@rohal12/spindle` already includes it, that covers LSP mode, but supplements must still be updated for standalone mode.

## Prettier Integration

### Dependency strategy

Prettier is loaded via **dynamic import** (`await import('prettier')`) with graceful fallback. If Prettier is not installed, the formatter skips HTML/JS/CSS formatting and applies only macro indentation and whitespace normalization. This preserves standalone operation in environments where Prettier is unavailable.

Prettier is added as an **optional dependency** (`optionalDependencies`) in `package.json` and listed in `external` in the esbuild config so it is not bundled into `dist/bin.js`.

### Usage

```typescript
let prettier: typeof import('prettier') | null = null;
try {
  prettier = await import('prettier');
} catch {
  // Prettier not available — skip HTML/JS/CSS formatting
}
```

When available, use `prettier.resolveConfig(process.cwd())` to pick up any `.prettierrc` in the project. Merge with sensible defaults:

```typescript
const resolvedConfig = await prettier.resolveConfig(process.cwd()) ?? {};
const baseConfig = { tabWidth: 2, ...resolvedConfig };

// HTML
await prettier.format(html, { ...baseConfig, parser: 'html', htmlWhitespaceSensitivity: 'ignore' });

// JS
await prettier.format(js, { ...baseConfig, parser: 'babel' });

// CSS
await prettier.format(css, { ...baseConfig, parser: 'css' });
```

### Error handling

If Prettier fails to parse a region (malformed HTML/JS/CSS), skip formatting that region and leave it as-is. Do not fail the entire document format.

## Segmentation

A passage body is classified into regions:

| Region type | Detection | Formatting |
|---|---|---|
| **Script passage** | Passage has `[script]` tag | Entire body -> Prettier `babel` parser |
| **Stylesheet passage** | Passage has `[stylesheet]` tag | Entire body -> Prettier `css` parser |
| **Inline `<script>`** | `<script>` to `</script>` tags | Content between tags -> Prettier `babel` parser |
| **HTML block** | Multi-line region of consecutive lines starting with `<` or continuation of an unclosed HTML tag (excluding `<script>`) | Spindle tokens -> placeholders, Prettier `html` parser, restore tokens |
| **Spindle/markdown** | Everything else | Macro indentation pass only |

### HTML block detection

An **HTML block** is a contiguous group of lines where:
- The first line starts with `<` followed by a tag name (not `<script>`)
- Subsequent lines are continuations while HTML tags remain unclosed (open tag count > close tag count), or themselves start with `<`
- The block ends when tags are balanced or a non-HTML line follows

Single inline HTML elements on a line (e.g., `<br>`, `<em>text</em>`) are **not** treated as HTML blocks — they remain in the Spindle/markdown region. Only multi-line HTML structures are sent to Prettier.

### Spindle placeholder substitution

Before passing HTML to Prettier, replace Spindle tokens with placeholders. Two placeholder formats are used depending on context:

- **In HTML content** (between tags): use HTML comments `<!--SP:0-->`
- **In HTML attributes**: use text placeholders `__SP0__`

The regex-based replacer checks whether each token appears inside an attribute value (between `="` and `"`) to choose the appropriate format. Tokens are indexed into an array that preserves the originals for restoration.

After Prettier formats the HTML, restore the original tokens by replacing placeholders back.

**Limitation:** Deeply nested Spindle macros inside HTML attributes (e.g., `{if $x}dark{else}light{/if}` as an attribute value) may not survive Prettier formatting cleanly. In such cases, the Prettier error handler catches the failure and the HTML block is left unformatted.

## Container Macro Indentation

### Algorithm

Operates only on **Spindle/markdown** regions (HTML and script regions are skipped):

```
indentLevel = 0

for each line:
  if passage header: reset indentLevel = 0, output line, continue
  if empty: output empty line, continue

  trimmed = line.trim()

  // Dedenting sub-macros (else, elseif, next) snap to parent level
  if trimmed starts with dedenting sub-macro tag:
    indentLevel = max(0, indentLevel - 1)
    output indented line
    indentLevel++
    continue

  // Closing tags reduce indent before output
  if trimmed starts with {/Name}:
    indentLevel = max(0, indentLevel - 1)

  output indented line

  // Opening container tags increase indent for next lines
  if trimmed starts with {Name ...} where Name is a container:
    indentLevel++
```

### Dedenting sub-macros

**Dedenting** (appear at parent's indent level): `else`, `elseif`, `next`, `case`, `default`

`{next}` inside `{timed}` works like `{else}` inside `{if}` — it separates sequential content phases. `{case}` and `{default}` inside `{switch}` work the same way — each starts a new branch.

**Note:** `{next}` always dedents regardless of parent context. Inside `{for}` (where it means "continue"), this may look unexpected but is acceptable for simplicity.

**Non-dedenting** (indented inside parent like regular content): `option`, `stop`

### Examples

```
{if $x}
  content
{elseif $y}
  more content
{else}
  fallback
{/if}

{switch $x}
{case "a"}
  branch a
{default}
  fallback
{/switch}

{Section "Vitals"}
  {StatBar "Fatigue" $pc.attributes.fatigue 10 "fill-amber"}
  {StatBar "Hunger" $pc.attributes.hunger 10 "fill-amber"}
{/Section}

{timed 2s}
  First
{next 2s}
  Second
{next}
  Third
{/timed}

{for @item of $list}
  {@item}
{/for}
```

## Affected Files

| File | Change |
|---|---|
| `src/plugins/format.ts` | Rewrite: async pipeline, segmentation, Prettier integration, registry-backed indentation, updated LSP plugin to pass callbacks and handle async |
| `src/cli/format.ts` | Update for async `formatDocument` |
| `src/mcp/server.ts` | Update for async `formatDocument` |
| `src/macro-supplements.json` | Add `unless` with `"container": true` if missing |
| `test/unit/format.test.ts` | Rewrite: new test cases for all features |
| `test/integration/cli-format.test.ts` | Update for new formatting behavior |
| `package.json` | Add `prettier` as optional dependency |
| `esbuild.config.ts` | Add `prettier` to external list |

## Test Plan

### Container macro indentation
- [ ] All builtin container macros indent their content (`button`, `do`, `link`, `timed`, `repeat`, `type`, `listbox`, `cycle`, `dialog`, `nobr`, `span`, `widget`, `if`, `for`, `switch`, `unless`)
- [ ] Custom macros auto-detected from `{/Name}` closing tags
- [ ] Registry-backed `isBlock` callback works when provided
- [ ] `{elseif}`, `{else}` dedent to parent level
- [ ] `{next}` inside `{timed}` dedents to parent level
- [ ] `{case}`, `{default}` dedent to parent level (like `{else}`)
- [ ] `{option}` remains indented inside parent
- [ ] Nested containers produce correct multi-level indentation
- [ ] Indent resets at passage boundaries

### HTML formatting
- [ ] Multi-line HTML blocks are indented by Prettier
- [ ] Single-line inline HTML (e.g., `<br>`, `<em>text</em>`) is left alone
- [ ] Spindle macros inside HTML content survive placeholder round-trip
- [ ] Spindle variable displays (`{$var}`) inside HTML survive
- [ ] Spindle links (`[[...]]`) inside HTML survive
- [ ] Malformed HTML is left as-is (no error)

### JavaScript formatting
- [ ] `[script]`-tagged passage body is formatted as JS
- [ ] `<script>` tag content is formatted as JS
- [ ] Malformed JS is left as-is (no error)

### CSS formatting
- [ ] `[stylesheet]`-tagged passage body is formatted as CSS

### Prettier unavailable
- [ ] When Prettier is not installed, formatter still applies macro indentation + whitespace normalization
- [ ] No errors thrown when Prettier is missing

### Idempotency
- [ ] Formatting an already-formatted document produces identical output
- [ ] Double-formatting produces same result as single-formatting

### Existing behavior preserved
- [ ] Trailing whitespace removal
- [ ] Single trailing newline
- [ ] Passage header normalization
- [ ] Empty line preservation

### Integration
- [ ] CLI `spindle-lsp format` works with async formatter
- [ ] CLI `spindle-lsp format --check` works with async formatter
- [ ] MCP `spindle_format` tool works with async formatter
- [ ] LSP document formatting works with registry-backed options
