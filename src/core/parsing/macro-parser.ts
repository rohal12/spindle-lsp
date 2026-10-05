import type { MacroNode, Range } from '../types.js';

/**
 * Regex for variable interpolation: {$var}, {_var}, {@var}
 * These must be neutralized before macro parsing to avoid false matches.
 */
const variableInterpolationRegex = /(?<!\\)\{([$_@%][A-Za-z_$][\w$.]*)\}/g;

/**
 * Spindle macro head: the opening brace up to the end of the macro name.
 * The arguments and the closing brace are found by createCodeScanner().
 * Groups:
 *   1 = closing slash (/) — present for closing macros
 *   2 = CSS prefix (e.g. ".red#alert ")
 *   3 = macro name
 */
const macroHeadRegex = /(?<!\\)\{(\/)?(?:((?:[#.][a-zA-Z][\w-]*\s*)*)([A-Za-z][\w-]*))(?=[\s}])/gi;

/**
 * A quote directly after a letter/digit is an apostrophe (don't), not a
 * string; after a backslash it is an escaped attribute delimiter (\").
 */
const NON_STRING_QUOTE_PREFIX = /[\p{L}\p{N}_\\]/u;

/** Lookups over one text, following Spindle's tokenizer through code. */
export interface CodeScanner {
  /** Index of the } that balances a { just before i, or -1 if it never closes. */
  closeBrace(i: number): number;
  /**
   * If a string or template literal starts at i, the index just past its
   * end; otherwise -1. A quote that can't start a string (apostrophe,
   * escaped) and a literal that never closes are text, as in Spindle.
   */
  literalEnd(i: number): number;
}

/**
 * Precompute Spindle's balanced-brace scan for every position from `from` on.
 *
 * Spindle's tokenizer scans for the } that closes a macro, skipping string
 * and template literals (including ${…} parts, which are scanned the same
 * way). A quote that can't start a string (apostrophe, escaped,
 * unterminated) counts as text, and so does a template that never closes.
 *
 * Scanning from a position follows the same path whatever the brace depth,
 * so each result only depends on results further right. Filling the tables
 * right to left therefore costs O(n), where re-scanning from every opening
 * brace or backtick is quadratic and an unclosed `${ inside a template
 * doubled the work per nesting level.
 */
function buildCodeScanner(input: string, from: number): CodeScanner {
  const n = input.length;
  // close[i]: the } closing a { just before i, or -1.
  const close = new Int32Array(n + 2).fill(-1);
  // template[j]: inside template literal text at j, the index just past the
  // closing backtick, or -1 if it never closes.
  const template = new Int32Array(n + 2).fill(-1);
  // single[j] / double[j]: inside a '…' / "…" string at j, the index just
  // past the closing quote, or -1 if not closed on the same line.
  const single = new Int32Array(n + 2).fill(-1);
  const double = new Int32Array(n + 2).fill(-1);

  const literalEnd = (i: number): number => {
    const c = input[i];
    if (c === '`') return template[i + 1];
    if (c !== '"' && c !== "'") return -1;
    if (i > 0 && NON_STRING_QUOTE_PREFIX.test(input[i - 1])) return -1;
    return (c === '"' ? double : single)[i + 1];
  };

  for (let i = n - 1; i >= from; i--) {
    const c = input[i];

    if (c === '\\') {
      single[i] = single[i + 2];
      double[i] = double[i + 2];
      template[i] = template[i + 2];
    } else {
      single[i] = c === "'" ? i + 1 : c === '\n' ? -1 : single[i + 1];
      double[i] = c === '"' ? i + 1 : c === '\n' ? -1 : double[i + 1];
      if (c === '`') {
        template[i] = i + 1;
      } else if (c === '$' && input[i + 1] === '{') {
        const interpolationEnd = close[i + 2];
        template[i] = interpolationEnd === -1 ? -1 : template[interpolationEnd + 1];
      } else {
        template[i] = template[i + 1];
      }
    }

    if (c === '}') {
      close[i] = i;
    } else if (c === '{') {
      // Depth 2: first find the } closing this {, then the next one.
      const inner = close[i + 1];
      close[i] = inner === -1 ? -1 : close[inner + 1];
    } else {
      const end = literalEnd(i);
      close[i] = close[end === -1 ? i + 1 : end];
    }
  }

  const inRange = (i: number) => i >= from && i < n;
  return {
    closeBrace: (i) => (inRange(i) ? close[i] : -1),
    literalEnd: (i) => (inRange(i) ? literalEnd(i) : -1),
  };
}

/**
 * Prepare balanced-brace and literal scans over the whole input. Use this
 * instead of scanBalancedBrace() when scanning the same text more than once.
 */
export function createCodeScanner(input: string): CodeScanner {
  return buildCodeScanner(input, 0);
}

/**
 * Scan for the balanced closing } starting at position i (just past the {),
 * the way Spindle's tokenizer finds the end of a macro. Braces inside string
 * and template literals are ignored. A quote that can't start a string
 * (apostrophe, escaped, unterminated) counts as text.
 * Returns the index of the closing } or -1 if unbalanced.
 */
export function scanBalancedBrace(input: string, i: number): number {
  if (i < 0 || i >= input.length) return -1;
  return buildCodeScanner(input, i).closeBrace(i);
}

/**
 * Build an array of line-start offsets from text.
 * lineStarts[i] is the character offset where line i begins.
 */
export function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * Convert a character offset to a line/character Position
 * using precomputed line-start offsets.
 */
export function offsetToPosition(offset: number, lineStarts: number[]): { line: number; character: number } {
  // Binary search for the line containing this offset
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { line: low, character: offset - lineStarts[low] };
}

/**
 * Parse all macros from the given text.
 *
 * Variable interpolation patterns ({$var}, {_var}, {@var}) are replaced with
 * same-length placeholder text before regex matching, preserving character offsets.
 *
 * A macro ends at its balanced closing brace, so object literals and strings
 * in the arguments are kept whole. A macro whose brace never closes is text,
 * and scanning resumes right after its opening brace.
 */
export function parseMacros(text: string): MacroNode[] {
  // Replace variable interpolation with same-length spaces to preserve offsets
  const cleaned = text.replace(variableInterpolationRegex, (match) => {
    return ' '.repeat(match.length);
  });

  const lineStarts = buildLineStarts(text);
  const scanner = createCodeScanner(cleaned);
  const macros: MacroNode[] = [];
  let id = 0;

  // Reset regex state (global regex)
  macroHeadRegex.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = macroHeadRegex.exec(cleaned)) !== null) {
    const matchStart = match.index;
    const closeIdx = scanner.closeBrace(matchStart + 1);
    if (closeIdx === -1) {
      // Unclosed macro — treat as text
      macroHeadRegex.lastIndex = matchStart + 1;
      continue;
    }
    const matchEnd = closeIdx + 1;
    macroHeadRegex.lastIndex = matchEnd;

    const closeSlash = match[1];
    const cssPrefix = (match[2] || '').trim();
    const macroName = match[3];
    // Arguments start after the whitespace following the name and run up to
    // the closing brace.
    const rawArgs = cleaned.slice(matchStart + match[0].length, closeIdx).replace(/^\s+/, '');

    const open = closeSlash !== '/';

    const startPos = offsetToPosition(matchStart, lineStarts);
    const endPos = offsetToPosition(matchEnd, lineStarts);

    const range: Range = {
      start: startPos,
      end: endPos,
    };

    macros.push({
      id,
      pair: -1,
      name: macroName,
      open,
      range,
      cssPrefix: cssPrefix || undefined,
      rawArgs: rawArgs || undefined,
    });

    id++;
  }

  return macros;
}

/**
 * Pair opening and closing macros the way Spindle's AST builder nests them.
 *
 * Block macros (isBlock(name) is true) share a single stack, so containers
 * must close in the reverse order they were opened. A closing macro pairs
 * with the nearest open container of the same name; containers opened after
 * that one are left unclosed (crossed nesting such as `{if}{for}{/if}{/for}`
 * leaves `{for}` and `{/for}` unpaired). A closing macro with no open
 * container of its name stays unpaired.
 *
 * `passageStartLines` lists the header lines of the passages in the text.
 * Each passage is rendered on its own, so the stack is reset at every
 * passage boundary and containers never pair across passages. When omitted,
 * the whole text is treated as one passage.
 *
 * Unmatched macros keep pair = -1.
 */
export function pairMacros(
  macros: MacroNode[],
  isBlock: (name: string) => boolean,
  passageStartLines: number[] = [],
): void {
  const boundaries = [...passageStartLines].sort((a, b) => a - b);
  let nextBoundary = 0;
  let stack: MacroNode[] = [];

  for (const macro of macros) {
    // Entering a new passage: anything still open stays unmatched.
    let crossed = false;
    while (nextBoundary < boundaries.length && macro.range.start.line >= boundaries[nextBoundary]) {
      nextBoundary++;
      crossed = true;
    }
    if (crossed) stack = [];

    if (!isBlock(macro.name)) continue;

    if (macro.open) {
      stack.push(macro);
      continue;
    }

    // Closing macro — find the nearest open container with the same name
    const name = macro.name.toLowerCase();
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name.toLowerCase() === name) {
        const opener = stack[i];
        opener.pair = macro.id;
        macro.pair = opener.id;
        // Containers opened inside it but never closed remain unmatched
        stack.length = i;
        break;
      }
    }
  }
}
