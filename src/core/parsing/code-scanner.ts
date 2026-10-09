/**
 * Spindle's balanced-brace scan through code: the closing brace of a macro
 * or display, skipping string and template literals.
 */

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
 * the way Spindle's tokenizer finds the end of a macro: braces inside string
 * and template literals are ignored, and a quote that can't start a string
 * (apostrophe, escaped, unterminated) counts as text.
 * Returns the index of the closing } or -1 if unbalanced.
 */
export function scanBalancedBrace(input: string, i: number): number {
  if (i < 0 || i >= input.length) return -1;
  return buildCodeScanner(input, i).closeBrace(i);
}
