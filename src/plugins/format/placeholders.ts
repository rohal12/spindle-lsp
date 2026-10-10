import { lexJs, lexTemplate, tokenizeMarkupTolerant, type Token } from '@rohal12/spindle/tooling';

export interface TokenMatch {
  start: number;
  end: number;
  token: string;
  /** Set for a token in the value of an HTML attribute (else absent). */
  inAttribute?: true;
}

/** A `{do}…{/do}` block: its body is JavaScript, run as written. */
export interface DoBlock {
  /** Start of `{do}` and end of `{/do}`. */
  start: number;
  end: number;
  /** The JavaScript between the two tags. */
  bodyStart: number;
  bodyEnd: number;
}

/** What the formatter must leave to the runtime in a piece of markup. */
export interface MarkupScan {
  /** Macros, variables, expressions and links (also those in attribute values), in source order. */
  tokens: TokenMatch[];
  /** The HTML tags (opening, closing and self-closing). */
  tags: { start: number; end: number }[];
  /** The `{do}…{/do}` blocks. */
  doBlocks: DoBlock[];
}

/**
 * Read `text` with Spindle's own tokenizer (`tokenizeMarkupTolerant`), so the
 * formatter protects exactly what the runtime executes. A token inside an
 * HTML attribute value is reported too, with the attribute-safe placeholder
 * it needs, because it must not be reformatted either.
 */
export function scanSpindleMarkup(text: string): MarkupScan {
  const tokens: TokenMatch[] = [];
  const tags: { start: number; end: number }[] = [];
  const doBlocks: DoBlock[] = [];
  let open: Token | undefined;

  const push = (t: { start: number; end: number }, inAttribute?: true) => {
    const match: TokenMatch = { start: t.start, end: t.end, token: text.slice(t.start, t.end) };
    if (inAttribute) match.inAttribute = true;
    tokens.push(match);
  };

  for (const t of tokenizeMarkupTolerant(text).tokens) {
    if (t.type === 'html') {
      tags.push({ start: t.start, end: t.end });
      for (const attribute of t.attributeSpans) {
        if (attribute.valueStart === undefined || attribute.valueEnd === undefined) continue;
        const value = text.slice(attribute.valueStart, attribute.valueEnd);
        if (!value.includes('{')) continue;
        for (const inner of tokenizeMarkupTolerant(value, { text: true }).tokens) {
          if (inner.type === 'macro' || inner.type === 'variable' || inner.type === 'expression') {
            push({ start: attribute.valueStart + inner.start, end: attribute.valueStart + inner.end }, true);
          }
        }
      }
    } else if (t.type !== 'text') {
      // The body of {do} is one text token, so nothing in it is a token
      if (t.type === 'macro' && t.name === 'do') {
        if (!t.isClose) open = t;
        else if (open) {
          doBlocks.push({ start: open.start, end: t.end, bodyStart: open.end, bodyEnd: t.start });
          open = undefined;
        }
      }
      push(t);
    }
  }
  return { tokens, tags, doBlocks };
}

/**
 * The ranges of the string and template literals of the JavaScript `code`
 * that span lines (outermost only): their line breaks are part of the value.
 */
export function multilineJsLiterals(code: string): [number, number][] {
  const spans: [number, number][] = [];
  let skipUntil = 0;
  lexJs(code, {
    literal(text, index, nesting) {
      if (nesting > 0 || index < skipUntil) return;
      const quote = text[0];
      if (quote === '`') {
        // The backtick that opens a template literal: its parts follow
        skipUntil = lexTemplate(code, index);
        if (code.slice(index, skipUntil).includes('\n')) spans.push([index, skipUntil]);
      } else if ((quote === '"' || quote === "'") && text.includes('\n')) {
        spans.push([index, index + text.length]);
      }
    },
  }, 'statements');
  return spans;
}

/** Whether an HTML tag (opening, closing or self-closing) overlaps the range. */
function lineHasTag(tags: { start: number; end: number }[], start: number, end: number): boolean {
  return tags.some(tag => tag.start < end && tag.end > start);
}

export interface PlaceholderResult {
  text: string;
  tokens: string[];
}

/**
 * Replace `<svg>…</svg>` blocks with HTML comment placeholders so Prettier
 * does not reformat them (CommonMark does not recognise multi-line SVG tags
 * as HTML blocks, so reformatted attributes break rendering).
 */
export function replaceSvgBlocks(html: string): PlaceholderResult {
  const tokens: string[] = [];
  const result = html.replace(/<svg[\s>][\s\S]*?<\/svg>/gi, (match) => {
    const idx = tokens.length;
    tokens.push(match);
    return `<!--SVG:${idx}-->`;
  });
  return { text: result, tokens };
}

/**
 * Restore SVG blocks from placeholders.
 */
export function restoreSvgBlocks(text: string, tokens: string[]): string {
  let result = text;
  for (let i = 0; i < tokens.length; i++) {
    // Callback form: a replacement string would expand `$&`, `$'`, etc.
    result = result.replace(`<!--SVG:${i}-->`, () => tokens[i]);
  }
  return result;
}

/**
 * Replace Spindle tokens with placeholders.
 * Uses <!--SP:N--> in HTML content and __SPN__ in attribute values.
 *
 * Lines that contain Spindle tokens but no HTML tags are replaced as a
 * single whole-line placeholder so Prettier cannot split them. A token that
 * spans lines (a template literal with a line break) keeps its line break:
 * the lines it spans are one line here. A `{do}…{/do}` block is one token:
 * its body is JavaScript executed as written, which an HTML formatter must
 * not re-indent or re-flow.
 */
export function replaceSpindleTokens(html: string): PlaceholderResult {
  const { tokens: found, tags, doBlocks } = scanSpindleMarkup(html);
  // The units to protect, in source order: a do block whole, else each token
  const units: TokenMatch[] = [];
  let doIndex = 0;
  for (const m of found) {
    while (doIndex < doBlocks.length && doBlocks[doIndex].end <= m.start) {
      const block = doBlocks[doIndex++];
      units.push({ start: block.start, end: block.end, token: html.slice(block.start, block.end) });
    }
    if (doBlocks[doIndex] && m.start >= doBlocks[doIndex].start) continue;
    units.push(m);
  }
  for (; doIndex < doBlocks.length; doIndex++) {
    const block = doBlocks[doIndex];
    units.push({ start: block.start, end: block.end, token: html.slice(block.start, block.end) });
  }
  units.sort((a, b) => a.start - b.start);

  const tokens: string[] = [];
  const resultLines: string[] = [];
  let unit = 0;
  let lineStart = 0;
  while (lineStart <= html.length) {
    // A line ends at a line break outside every unit
    let lineEnd = lineStart;
    const lineUnits: TokenMatch[] = [];
    for (;;) {
      while (unit < units.length && units[unit].end <= lineEnd) unit++;
      const inside = units[unit] && units[unit].start <= lineEnd ? units[unit] : undefined;
      if (inside) {
        lineUnits.push(inside);
        lineEnd = inside.end;
        unit++;
        continue;
      }
      if (lineEnd >= html.length || html[lineEnd] === '\n') break;
      lineEnd++;
    }
    const line = html.slice(lineStart, lineEnd);
    const indent = line.match(/^(\s*)/)?.[1] ?? '';

    if (lineUnits.length === 0) {
      resultLines.push(line);
    } else if (!lineHasTag(tags, lineStart, lineEnd)) {
      // Spindle tokens but no HTML: one placeholder for the whole line
      const idx = tokens.length;
      tokens.push(line.trim());
      resultLines.push(`${indent}<!--SP:${idx}-->`);
    } else {
      // Both HTML and Spindle: one placeholder per token, in source order
      let replaced = '';
      let last = lineStart;
      for (const u of lineUnits) {
        const idx = tokens.length;
        tokens.push(u.token);
        replaced += html.slice(last, u.start) + (u.inAttribute ? `__SP${idx}__` : `<!--SP:${idx}-->`);
        last = u.end;
      }
      resultLines.push(replaced + html.slice(last, lineEnd));
    }
    lineStart = lineEnd + 1;
  }

  return { text: resultLines.join('\n'), tokens };
}

/**
 * Restore original Spindle tokens from placeholders.
 */
export function restoreSpindleTokens(text: string, tokens: string[]): string {
  let result = text;
  for (let i = 0; i < tokens.length; i++) {
    // Callback form: a replacement string would expand `$&`, `$'`, etc.
    result = result.replace(`<!--SP:${i}-->`, () => tokens[i]);
    result = result.replace(`__SP${i}__`, () => tokens[i]);
  }
  return result;
}
