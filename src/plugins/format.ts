import type { Range } from '../core/types.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { builtinMacros, tokenizeMarkupTolerant, type MacroToken } from '@rohal12/spindle/tooling';
import { splitPassages, classifyPassage, segmentRegions } from './format/segment.js';
import { formatJS, formatCSS, formatHTML as formatHTMLPrettier } from './format/prettier-bridge.js';
import {
  multilineJsLiterals,
  replaceSpindleTokens,
  restoreSpindleTokens,
  replaceSvgBlocks,
  restoreSvgBlocks,
  scanSpindleMarkup,
} from './format/placeholders.js';

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
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const PASSAGE_HEADER_REGEX = /^(::)\s+/;

/** Default dedenting sub-macros. */
const DEFAULT_DEDENTING = new Set(['else', 'elseif', 'next', 'case', 'default']);

// ---------------------------------------------------------------------------
// Default block detection from the built-in macros + document scan
// ---------------------------------------------------------------------------

/** The built-in block macros, lowercased. */
const BUILTIN_CONTAINERS = new Set(builtinMacros.filter(m => m.block).map(m => m.name.toLowerCase()));

/** The names of the macros the document closes with `{/name}`: block macros it defines itself. */
function detectContainersFromText(text: string): Set<string> {
  const found = new Set<string>();
  for (const t of tokenizeMarkupTolerant(text).tokens) {
    if (t.type === 'macro' && t.isClose) found.add(t.name.toLowerCase());
  }
  return found;
}

/** Build an isBlock function from the built-in block macros + document auto-detection. */
function buildDefaultIsBlock(text: string): (name: string) => boolean {
  const containers = new Set([...BUILTIN_CONTAINERS, ...detectContainersFromText(text)]);
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
 *
 * The body of a `{do}` macro is JavaScript, executed as written: a template
 * literal (or a string continued with a backslash) that spans lines is a
 * value, so its line breaks and the whitespace after them must survive
 * formatting. Those literals are joined too.
 */
function protectMultilineTokens(body: string, sentinel: string): string {
  const { tokens, doBlocks } = scanSpindleMarkup(body);
  const spans: [number, number][] = [];
  for (const m of tokens) {
    if (m.token.includes('\n')) spans.push([m.start, m.end]);
  }
  for (const block of doBlocks) {
    for (const [a, b] of multilineJsLiterals(body.slice(block.bodyStart, block.bodyEnd))) {
      spans.push([block.bodyStart + a, block.bodyStart + b]);
    }
  }
  spans.sort((x, y) => x[0] - y[0]);
  let out = '';
  let last = 0;
  for (const [a, b] of spans) {
    out += body.slice(last, a) + body.slice(a, b).replaceAll('\n', sentinel);
    last = b;
  }
  return out + body.slice(last);
}

async function formatLf(text: string, options?: FormatOptions): Promise<string> {
  const isBlock = options?.isBlock ?? buildDefaultIsBlock(text);
  const isDedenting = options?.isDedentingSubMacro
    ?? ((name: string) => DEFAULT_DEDENTING.has(name.toLowerCase()));

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
    const regions = segmentRegions(protectMultilineTokens(passage.body, sentinel));

    for (const region of regions) {
      if (region.type !== 'spindle') {
        // Their text is verbatim, JS or HTML (protected by placeholders): undo the joining
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
        const { text: placeholdered, tokens } = replaceSpindleTokens(svgPlaceholdered);
        const formatted = await formatHTMLPrettier(placeholdered);
        // A token's line breaks are its payload: keep them out of the line steps below
        const restoredSpindle = restoreSpindleTokens(formatted.trim(), tokens.map(t => t.replaceAll('\n', sentinel)));
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
  const macrosOnLine = macroTokensByLine(lines);
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

    // The macro the line starts with, and the closers that follow it
    const lead = lines[i].length - lines[i].trimStart().length;
    const [first, ...rest] = macrosOnLine[i];
    const startsWithMacro = first !== undefined && first.start === lead;

    // Dedenting sub-macro: closes the previous branch, opens the next one
    if (startsWithMacro && !first.isClose && isDedenting(first.name)) {
      const closed = closeBody();
      if (closed === undefined) addLine(col, trimmed);
      else info.push({ body: stack[stack.length - 1], closes: closed, col, text: trimmed });
      openBody(i);
      continue;
    }

    // Closing tag
    const closed = startsWithMacro && first.isClose ? closeBody() : undefined;
    if (closed === undefined) addLine(col, trimmed);
    else info.push({ body: stack[stack.length - 1], closes: closed, col, text: trimmed });

    // Opening container tag
    if (startsWithMacro && !first.isClose && isBlock(first.name)) {
      openBody(i);
    }

    // Closing tags that appear later on the same line (not at the start,
    // which is already handled by the close-at-start check above).
    for (const macro of startsWithMacro ? rest : macrosOnLine[i]) {
      if (macro.isClose && macro.start > lead) closeBody();
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

/**
 * The macro tags on each of `lines`, as Spindle tokenizes the lines together
 * (`start` is the offset in the line). A tag spans one line here: the
 * multiline ones were joined onto their line.
 */
function macroTokensByLine(lines: string[]): MacroToken[][] {
  const byLine: MacroToken[][] = lines.map(() => []);
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  let line = 0;
  for (const token of tokenizeMarkupTolerant(lines.join('\n')).tokens) {
    if (token.type !== 'macro') continue;
    while (line + 1 < lines.length && starts[line + 1] <= token.start) line++;
    byLine[line].push({ ...token, start: token.start - starts[line], end: token.end - starts[line] });
  }
  return byLine;
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
 * Wrap a single trimmed line at word boundaries, never inside a macro, an
 * interpolation or a link (as Spindle tokenizes the line).
 * Returns an array of lines with the given indent prefix applied.
 */
function wordWrap(text: string, maxLen: number, indent: string): string[] {
  const lines: string[] = [];
  /** Whether the character is inside a token whose text must stay as written. */
  const inToken = new Array<boolean>(text.length).fill(false);
  for (const token of tokenizeMarkupTolerant(text).tokens) {
    if (token.type === 'text' || token.type === 'html') continue;
    inToken.fill(true, token.start, token.end);
  }
  const room = maxLen - indent.length;
  let pos = 0;

  while (pos < text.length) {
    if (text.length - pos <= room) {
      lines.push(indent + text.slice(pos));
      break;
    }

    // Find the last space at or before the limit that isn't inside a token
    let breakIdx = -1;
    for (let i = pos + 1; i < text.length && i - pos <= room; i++) {
      if (text[i] === ' ' && !inToken[i]) breakIdx = i;
    }

    // If no break point found before the limit, look for the next space after
    if (breakIdx === -1) {
      for (let i = pos + room + 1; i < text.length; i++) {
        if (text[i] === ' ' && !inToken[i]) {
          breakIdx = i;
          break;
        }
      }
    }

    // No break point at all — emit the whole thing
    if (breakIdx === -1) {
      lines.push(indent + text.slice(pos));
      break;
    }

    lines.push(indent + text.slice(pos, breakIdx));
    pos = breakIdx + 1;
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
