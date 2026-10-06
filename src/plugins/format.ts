import type { Range } from '../core/types.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import supplements from '../macro-supplements.json' with { type: 'json' };
import { SELECTOR_PATTERN } from '../core/parsing/macro-parser.js';
import { splitPassages, classifyPassage, segmentRegions } from './format/segment.js';
import { formatJS, formatCSS, formatHTML as formatHTMLPrettier } from './format/prettier-bridge.js';
import { replaceSpindleTokens, restoreSpindleTokens, replaceSvgBlocks, restoreSvgBlocks, scanSpindleTokens } from './format/placeholders.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormatOptions {
  /** Returns true if the named macro is a block/container macro. */
  isBlock?: (name: string) => boolean;
  /** Returns true for sub-macros that dedent to parent level (else, elseif, next, case, default). */
  isDedentingSubMacro?: (name: string) => boolean;
  /** If set, wrap prose lines exceeding this character count. */
  maxLineLength?: number;
  /**
   * The target Spindle's tokenizer skips strings when it counts braces
   * (`SpindleCapabilities.stringAwareBraces`, >= 0.50.1). Default: it does not.
   */
  stringAwareBraces?: boolean;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const PASSAGE_HEADER_REGEX = /^(::)\s+/;

/** Matches an opening macro tag, capturing optional CSS prefix and macro name. */
const MACRO_OPEN_REGEX = new RegExp(String.raw`^\{(?:${SELECTOR_PATTERN} )?([A-Za-z][\w-]*)\b`);

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
 *  2. Dedenting sub-macros (else, elseif, next, case, default) snap to parent indent level
 *  3. Remove trailing whitespace from each line, keeping Markdown hard breaks
 *     (two trailing spaces) and list/code-fence indentation in prose
 *  4. Ensure file ends with a single newline
 *  5. Normalize passage headers: `::  Name  [tag]` -> `:: Name [tag]`
 */
export async function formatDocument(text: string, options?: FormatOptions): Promise<string> {
  // A byte order mark is not story text: format what follows it and keep the mark
  if (text.charCodeAt(0) === 0xfeff) return '\uFEFF' + await formatDocument(text.slice(1), options);
  // Format with LF endings, then give the output the document's own style
  const eol = dominantEol(text);
  const output = await formatLf(text.replace(/\r\n/g, '\n'), options);
  return eol === '\r\n' ? output.replace(/\n/g, '\r\n') : output;
}

/**
 * The document's line-ending style: whichever of CRLF and LF is more common,
 * the first one found when equally common. (Spindle's compiler normalizes
 * CRLF to LF, so the choice never changes what a story does.)
 */
function dominantEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  if (crlf !== lf) return crlf > lf ? '\r\n' : '\n';
  return text.indexOf('\r\n') !== -1 && text.indexOf('\r\n') < text.indexOf('\n') ? '\r\n' : '\n';
}

/**
 * Newline stand-in inside multiline Spindle tokens. A private-use character
 * absent from the document: not whitespace, so no line-based step touches it.
 */
function newlineSentinel(text: string): string {
  for (let code = 0xe000; code <= 0xf8ff; code++) {
    const ch = String.fromCharCode(code);
    if (!text.includes(ch)) return ch;
  }
  throw new Error('no free private-use character for the newline stand-in');
}

/**
 * Join each multiline token (macro, interpolation or link, as the Spindle
 * runtime tokenizes it) onto its line with `sentinel` for its newlines. The
 * line-based formatting steps then see one line and cannot re-indent, wrap,
 * trim, segment or re-flow the runtime payload inside it.
 */
function protectMultilineTokens(body: string, sentinel: string, stringAwareBraces: boolean): string {
  return protectTokenLines(protectDoLiterals(body, sentinel, stringAwareBraces), sentinel, stringAwareBraces);
}

/**
 * The body of a `{do}` macro is JavaScript, executed as written: a template
 * literal (or a string continued with a backslash) that spans lines is a value,
 * so its line breaks and the whitespace after them must survive formatting.
 * Join each such literal onto one line with `sentinel` for its newlines.
 */
function protectDoLiterals(body: string, sentinel: string, stringAwareBraces: boolean): string {
  if (!body.includes('`') && !body.includes('\\\n')) return body;
  let out = '';
  let last = 0;
  let open: number | null = null;
  for (const m of scanSpindleTokens(body, { stringAwareBraces })) {
    if (open === null) {
      if (MACRO_OPEN_REGEX.exec(m.token)?.[1].toLowerCase() === 'do') open = m.end;
      continue;
    }
    if (MACRO_CLOSE_REGEX.exec(m.token)?.[1].toLowerCase() !== 'do') continue;
    for (const [a, b] of multilineJsLiterals(body.slice(open, m.start))) {
      out += body.slice(last, open + a) + body.slice(open + a, open + b).replaceAll('\n', sentinel);
      last = open + b;
    }
    open = null;
  }
  return out + body.slice(last);
}

/** Keywords after which a `/` starts a regex literal rather than dividing. */
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

/**
 * End index (exclusive) of the regex literal starting at `code[from] === '/'`,
 * or -1 when no closing `/` precedes the end of the line (a regex literal
 * cannot span lines, so the `/` is not one). A `/` inside a character class
 * `[...]` and escaped characters do not close it; flags are consumed.
 */
function regexLiteralEnd(code: string, from: number): number {
  let i = from + 1;
  let inClass = false;
  while (i < code.length && code[i] !== '\n') {
    const ch = code[i];
    if (ch === '\\') i += 2;
    else if (ch === '[') { inClass = true; i++; }
    else if (ch === ']') { inClass = false; i++; }
    else if (ch === '/' && !inClass) {
      i++;
      while (i < code.length && /[A-Za-z0-9_$]/.test(code[i])) i++;
      return i;
    } else i++;
  }
  return -1;
}

/** Ranges of the string and template literals in `code` that contain a newline (outermost only). */
function multilineJsLiterals(code: string): [number, number][] {
  const spans: [number, number][] = [];
  /** Scan from `start`; when `nested`, stop after the `}` closing a `${`. Returns the index reached. */
  const scanCode = (start: number, nested: boolean): number => {
    let i = start;
    let depth = 0;
    /** Whether a `/` here starts a regex literal (else it divides), from the previous significant token. */
    let regexAllowed = true;
    while (i < code.length) {
      const ch = code[i];
      if (ch === '/' && code[i + 1] === '/') {
        while (i < code.length && code[i] !== '\n') i++;
      } else if (ch === '/' && code[i + 1] === '*') {
        const end = code.indexOf('*/', i + 2);
        i = end === -1 ? code.length : end + 2;
      } else if (ch === '/') {
        const end = regexAllowed ? regexLiteralEnd(code, i) : -1;
        if (end >= 0) {
          i = end;
          regexAllowed = false;
        } else {
          i++;
          regexAllowed = true;
        }
      } else if (ch === '"' || ch === "'") {
        const from = i++;
        while (i < code.length && code[i] !== ch && code[i] !== '\n') i += code[i] === '\\' ? 2 : 1;
        // Only a backslash-newline continuation can carry a newline into a string
        i = Math.min(i, code.length);
        if (code.slice(from, i).includes('\n')) spans.push([from, i + 1]);
        i++;
        regexAllowed = false;
      } else if (ch === '`') {
        const from = i++;
        while (i < code.length && code[i] !== '`') {
          if (code[i] === '\\') i += 2;
          else if (code[i] === '$' && code[i + 1] === '{') i = scanCode(i + 2, true);
          else i++;
        }
        i = Math.min(i + 1, code.length);
        if (code.slice(from, i).includes('\n')) spans.push([from, i]);
        regexAllowed = false;
      } else if (ch === '{') {
        depth++;
        i++;
        regexAllowed = true;
      } else if (ch === '}') {
        if (nested && depth === 0) return i + 1;
        depth--;
        i++;
        regexAllowed = true;
      } else if (/[A-Za-z0-9_$]/.test(ch)) {
        const from = i;
        while (i < code.length && /[A-Za-z0-9_$.]/.test(code[i])) i++;
        const word = code.slice(from, i);
        regexAllowed = REGEX_AFTER_KEYWORD.has(word);
      } else if (ch === ')' || ch === ']') {
        i++;
        regexAllowed = false;
      } else {
        i++;
        if (!/\s/.test(ch)) regexAllowed = true;
      }
    }
    return i;
  };
  scanCode(0, false);
  return spans
    .sort((x, y) => x[0] - y[0] || y[1] - x[1])
    .filter(([a, b], k, all) => !all.slice(0, k).some(([c, d]) => c <= a && b <= d));
}

function protectTokenLines(body: string, sentinel: string, stringAwareBraces: boolean): string {
  let out = '';
  let last = 0;
  for (const m of scanSpindleTokens(body, { stringAwareBraces })) {
    if (!m.token.includes('\n')) continue;
    out += body.slice(last, m.start) + m.token.replaceAll('\n', sentinel);
    last = m.end;
  }
  return out + body.slice(last);
}

async function formatLf(text: string, options?: FormatOptions): Promise<string> {
  const isBlock = options?.isBlock ?? buildDefaultIsBlock(text);
  const isDedenting = options?.isDedentingSubMacro
    ?? ((name: string) => DEFAULT_DEDENTING.has(name.toLowerCase()));

  const stringAware = options?.stringAwareBraces === true;
  const passages = splitPassages(text);
  const sentinel = newlineSentinel(text);
  const resultLines: string[] = [];
  /** Indices in resultLines whose trailing two spaces are a hard line break. */
  const hardBreakLines = new Set<number>();

  for (let pi = 0; pi < passages.length; pi++) {
    const passage = passages[pi];

    // Preserve blank line separator between passages when the original had one
    if (pi > 0 && passage.header) {
      const prev = passages[pi - 1];
      const prevBodyLineCount = prev.body ? prev.body.split('\n').length - 1 : 0;
      const prevEndLine = prev.startLine + (prev.header ? 1 : 0) + prevBodyLineCount;
      if (passage.startLine > prevEndLine) {
        // There were blank lines between passages — emit one blank separator
        resultLines.push('');
      }
    }

    // Normalize and emit passage header
    if (passage.header) {
      const header = PASSAGE_HEADER_REGEX.test(passage.header)
        ? normalizePassageHeader(passage.header)
        : passage.header;
      resultLines.push(header);
    }

    const kind = classifyPassage(passage.header);

    if (kind === 'script') {
      const formatted = await formatJS(passage.body.trim());
      resultLines.push(formatted.trim());
      continue;
    }

    if (kind === 'stylesheet') {
      const formatted = await formatCSS(passage.body.trim());
      resultLines.push(formatted.trim());
      continue;
    }

    // Normal passage: segment into regions. Multiline tokens are joined onto
    // one line first, so their inner lines are never taken for markup.
    const regions = segmentRegions(protectMultilineTokens(passage.body, sentinel, stringAware));

    for (const region of regions) {
      if (region.type === 'script' || region.type === 'svg') {
        // Their text is verbatim or JS: undo the joining
        region.lines = region.lines.map(l => l.replaceAll(sentinel, '\n'));
      }

      if (region.type === 'script') {
        // Same-line <script>…</script> — leave as written
        if (region.lines.length === 1) {
          resultLines.push(region.lines[0]);
          continue;
        }
        // Inline <script> — format JS content between tags
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

      if (region.type === 'svg') {
        // SVG block — leave untouched (Prettier would break rendering)
        resultLines.push(...region.lines);
        continue;
      }

      if (region.type === 'html') {
        // HTML block — placeholder substitution + Prettier
        const htmlText = region.lines.join('\n');
        const { text: svgPlaceholdered, tokens: svgTokens } = replaceSvgBlocks(htmlText);
        const { text: placeholdered, tokens } = replaceSpindleTokens(svgPlaceholdered, { stringAwareBraces: stringAware });
        const formatted = await formatHTMLPrettier(placeholdered);
        const restoredSpindle = restoreSpindleTokens(formatted.trim(), tokens);
        const restored = restoreSvgBlocks(restoredSpindle, svgTokens);
        for (const fLine of restored.split('\n')) {
          resultLines.push(fLine);
        }
        continue;
      }

      // Spindle/markdown region — apply macro indentation
      let indented = indentMacros(region.lines, isBlock, isDedenting);
      if (options?.maxLineLength) {
        indented = wrapLines(indented, options.maxLineLength);
      }
      for (const line of indented) {
        if (line.endsWith('  ')) hardBreakLines.add(resultLines.length);
        resultLines.push(line);
      }
    }
  }

  // Strip trailing whitespace (except Markdown hard breaks, already
  // normalized by indentMacros) and ensure single trailing newline
  let output = resultLines
    .map((l, i) => (hardBreakLines.has(i) ? l : l.replace(/\s+$/, '')))
    .join('\n');
  output = output.replace(/\n*$/, '\n');

  return output.replaceAll(sentinel, '\n');
}

/** A Markdown list item line (`- a`, `* a`, `+ a`, `1. a`, `1) a`). */
const LIST_ITEM_REGEX = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;

/** A fenced code block delimiter. */
const CODE_FENCE_REGEX = /^(?:`{3,}|~{3,})/;

/**
 * A block macro body. Spindle renders each body's children as a separate
 * Markdown document, so shifting all of a body's lines by the same amount
 * never changes how it renders.
 */
interface MacroBody {
  /** Index of the line that opened this body; -1 for the region root. */
  openLine: number;
  /** Smallest original indentation column among the body's lines. */
  minCol: number;
  /** True if leading indentation may be Markdown syntax (lists, code fences). */
  keepRelative: boolean;
}

/**
 * Re-indent macro bodies by nesting depth.
 *
 * Each body is re-based so its least-indented line sits 2 spaces inside the
 * line that opened it. When the body contains Markdown whose meaning depends
 * on indentation (list items and their continuations, fenced code), every
 * line keeps its indentation relative to that base (top-level lines keep
 * their original indentation); otherwise all lines snap to the base, since
 * leading whitespace in Spindle's Markdown (indented code blocks are
 * disabled) is insignificant. Closing tags and dedenting sub-macros align
 * with their opening tag.
 *
 * Trailing whitespace is stripped, except that two or more trailing spaces
 * before a non-blank line (a Markdown hard line break) become exactly two.
 */
function indentMacros(
  lines: string[],
  isBlock: (name: string) => boolean,
  isDedenting: (name: string) => boolean,
): string[] {
  // Pass 1: assign each line to the body (Markdown document) it belongs to.
  const bodies: MacroBody[] = [{ openLine: -1, minCol: Infinity, keepRelative: false }];
  const stack: number[] = [0];
  /** Per line: owning body, or the body it closes (`closes`), and its column. */
  const info: ({ body: number; closes?: number; col: number; text: string } | null)[] = [];

  const openBody = (line: number) => {
    bodies.push({ openLine: line, minCol: Infinity, keepRelative: false });
    stack.push(bodies.length - 1);
  };
  const closeBody = (): number | undefined => (stack.length > 1 ? stack.pop() : undefined);
  const addLine = (col: number, text: string) => {
    const body = bodies[stack[stack.length - 1]];
    body.minCol = Math.min(body.minCol, col);
    if (LIST_ITEM_REGEX.test(text) || CODE_FENCE_REGEX.test(text)) body.keepRelative = true;
    info.push({ body: stack[stack.length - 1], col, text });
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed === '') {
      info.push(null);
      continue;
    }
    const col = indentColumn(lines[i]);

    // Dedenting sub-macro: closes the previous branch, opens the next one
    const dedentMatch = trimmed.match(MACRO_OPEN_REGEX);
    if (dedentMatch && isDedenting(dedentMatch[1])) {
      const closed = closeBody();
      if (closed === undefined) addLine(col, trimmed);
      else info.push({ body: stack[stack.length - 1], closes: closed, col, text: trimmed });
      openBody(i);
      continue;
    }

    // Closing tag
    const closed = MACRO_CLOSE_REGEX.test(trimmed) ? closeBody() : undefined;
    if (closed === undefined) addLine(col, trimmed);
    else info.push({ body: stack[stack.length - 1], closes: closed, col, text: trimmed });

    // Opening container tag
    const openMatch = trimmed.match(MACRO_OPEN_REGEX);
    if (openMatch && isBlock(openMatch[1])) {
      openBody(i);
    }

    // Closing tags that appear later on the same line (not at position 0,
    // which is already handled by the close-at-start check above).
    const closeGlobal = /\{\/[A-Za-z][\w-]*\s*\}/g;
    let cm: RegExpExecArray | null;
    while ((cm = closeGlobal.exec(trimmed)) !== null) {
      if (cm.index > 0) closeBody();
    }
  }

  // Pass 2: compute output indentation.
  const outCol: number[] = [];
  const result: string[] = [];
  for (let i = 0; i < info.length; i++) {
    const line = info[i];
    if (!line) {
      outCol.push(0);
      result.push('');
      continue;
    }
    let col: number;
    if (line.closes !== undefined) {
      col = outCol[bodies[line.closes].openLine];
    } else {
      // The region root keeps its original indentation when it matters
      const body = bodies[line.body];
      const isRoot = body.openLine === -1;
      const base = isRoot ? 0 : outCol[body.openLine] + 2;
      col = base + (body.keepRelative ? line.col - (isRoot ? 0 : body.minCol) : 0);
    }
    outCol.push(col);
    const hardBreak = / {2,}$/.test(lines[i]) && info[i + 1] ? '  ' : '';
    result.push(' '.repeat(col) + line.text + hardBreak);
  }

  return result;
}

/** Column of the first non-whitespace character, expanding tabs to 4-column stops. */
function indentColumn(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
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
// Line wrapping
// ---------------------------------------------------------------------------

/**
 * Wrap lines that exceed maxLen at word boundaries.
 * Preserves leading indentation. Skips lines that are passage headers,
 * pure macro lines, or choice/link lines where wrapping would break syntax.
 */
function wrapLines(lines: string[], maxLen: number): string[] {
  const result: string[] = [];

  for (const line of lines) {
    if (line.length <= maxLen) {
      result.push(line);
      continue;
    }

    const trimmed = line.trim();

    // Don't wrap empty lines, passage headers, or lines that are purely
    // structural (macros, links, choices)
    if (
      trimmed === '' ||
      /^::/.test(trimmed) ||
      /^\{[\/#.]/.test(trimmed) ||         // closing/opening-only macro lines
      /^\[\[/.test(trimmed) ||             // links
      /^\{choice\b/.test(trimmed) ||       // choice macros
      /^\{choices\b/.test(trimmed)
    ) {
      result.push(line);
      continue;
    }

    // Determine the indentation prefix
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';

    const wrapped = wordWrap(trimmed, maxLen, indent);
    // Keep a Markdown hard break on the last wrapped line
    if (line.endsWith('  ')) wrapped[wrapped.length - 1] += '  ';
    result.push(...wrapped);
  }

  return result;
}

/**
 * Wrap a single trimmed line at word boundaries, respecting macro tokens.
 * Returns an array of lines with the given indent prefix applied.
 */
function wordWrap(text: string, maxLen: number, indent: string): string[] {
  const lines: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const currentMax = lines.length === 0 ? maxLen - indent.length : maxLen - indent.length;
    if (remaining.length <= currentMax) {
      lines.push(indent + remaining);
      break;
    }

    // Find the last space at or before currentMax that isn't inside a macro tag
    let breakIdx = -1;
    let inMacro = 0;
    for (let i = 0; i < remaining.length && i <= currentMax; i++) {
      if (remaining[i] === '{') inMacro++;
      else if (remaining[i] === '}') inMacro = Math.max(0, inMacro - 1);
      else if (remaining[i] === ' ' && inMacro === 0 && i > 0) {
        breakIdx = i;
      }
    }

    // If no break point found before maxLen, look for the next space after
    if (breakIdx === -1) {
      for (let i = currentMax + 1; i < remaining.length; i++) {
        if (remaining[i] === '{') inMacro++;
        else if (remaining[i] === '}') inMacro = Math.max(0, inMacro - 1);
        else if (remaining[i] === ' ' && inMacro === 0) {
          breakIdx = i;
          break;
        }
      }
    }

    // No break point at all — emit the whole thing
    if (breakIdx === -1) {
      lines.push(indent + remaining);
      break;
    }

    lines.push(indent + remaining.substring(0, breakIdx));
    remaining = remaining.substring(breakIdx + 1);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePassageHeader(line: string): string {
  const headerMatch = line.match(/^::\s+(.*)/);
  if (!headerMatch) return line;

  const rest = headerMatch[1];
  // Neutralize backslash escapes (keeping offsets) the way the passage parser
  // does, so an escaped `\[` or `\{` in the name does not start tags/metadata.
  const unescaped = rest.replace(/\\./g, 'ec');
  const bracketIdx = unescaped.indexOf('[');
  const braceIdx = unescaped.indexOf('{');

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
      // Block widgets (whose body renders {@children}) are containers too
      isBlock: (name) => ctx.workspace.isContainer(name),
      isDedentingSubMacro: (name) => DEFAULT_DEDENTING.has(name.toLowerCase()),
      // Read per request: the target version is re-detected as files change
      get stringAwareBraces() { return ctx.workspace.capabilities.stringAwareBraces; },
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
