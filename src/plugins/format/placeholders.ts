/** Detect HTML tags in text (opening or self-closing or closing). */
const HTML_TAG_REGEX = /<\/?[a-zA-Z][\w-]*[\s>/]/;

export interface TokenMatch {
  start: number;
  end: number;
  token: string;
}

/**
 * Scan text for Spindle tokens the way the Spindle 0.45.1 runtime tokenizer
 * (`src/markup/tokenizer.ts` in @rohal12/spindle) does, so the formatter
 * protects exactly the spans the runtime executes. Finds closing tags, macro
 * calls, CSS-prefixed macros, variable/expression interpolations and
 * [[links]] (the runtime's token kinds).
 *
 * Like the runtime, this counts braces and does not look at string contents:
 * a stray `{` in a string extends the macro to the next balanced `}`, and an
 * unbalanced `{` is plain text. Differs from the runtime in one way, on
 * purpose: tokens inside the attribute values of an HTML tag are reported
 * too (the runtime keeps them inside its HTML token) because they must not
 * be reformatted either. `test/unit/placeholders-oracle.test.ts` checks the
 * two against each other.
 */
export function scanSpindleTokens(text: string): TokenMatch[] {
  return scan(text, true);
}

/** Scan once; `html` enables HTML tag recognition (off inside a tag's own text). */
function scan(input: string, html: boolean): TokenMatch[] {
  const matches: TokenMatch[] = [];
  const push = (start: number, end: number) =>
    matches.push({ start, end, token: input.slice(start, end) });
  let i = 0;

  while (i < input.length) {
    // Escaped braces are text: \{ and \}
    if (input[i] === '\\' && (input[i + 1] === '{' || input[i + 1] === '}')) {
      i += 2;
      continue;
    }

    // [[link]], with optional .class/#id selectors; links may nest
    if (input[i] === '[' && input[i + 1] === '[') {
      const start = i;
      i += 2;
      if (input[i] === '.' || input[i] === '#') {
        i = parseSelectors(input, i);
        if (input[i] === ' ') i++;
      }
      let depth = 1;
      while (i < input.length && depth > 0) {
        if (input[i] === '[' && input[i + 1] === '[') {
          depth++;
          i += 2;
        } else if (input[i] === ']' && input[i + 1] === ']') {
          depth--;
          if (depth === 0) break;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth !== 0) {
        i = start + 2; // unclosed link: text, scanning resumes after `[[`
        continue;
      }
      i += 2;
      push(start, i);
      continue;
    }

    if (input[i] === '{') {
      const start = i;
      if (isTokenStart(input, i)) {
        const close = scanBalancedBrace(input, i + 1);
        if (close !== -1) {
          i = close + 1;
          push(start, i);
          continue;
        }
      }
      i++; // bare or unbalanced brace: text
      continue;
    }

    if (html && input[i] === '<') {
      const end = htmlTagEnd(input, i);
      if (end !== -1) {
        // Attribute values hold tokens that must stay intact as well
        for (const m of scan(input.slice(i, end), false)) push(i + m.start, i + m.end);
        i = end;
        continue;
      }
    }

    i++;
  }

  return matches;
}

/** Index of the `}` balancing an open brace whose content starts at `i`, or -1. */
function scanBalancedBrace(input: string, i: number): number {
  let depth = 1;
  while (i < input.length && depth > 0) {
    if (input[i] === '{') depth++;
    else if (input[i] === '}') depth--;
    if (depth > 0) i++;
  }
  return depth === 0 ? i : -1;
}

/**
 * Does the `{` at `i` open a token (given a balanced end)? Mirrors the
 * runtime: a sigil, a `/` or a letter follows it, or CSS selectors followed
 * by a sigil or a letter.
 */
function isTokenStart(input: string, i: number): boolean {
  const next = input[i + 1];
  if (next === '.' || next === '#') {
    let after = parseSelectors(input, i + 1);
    if (input[after] === ' ') after++;
    const ch = input[after];
    return ch !== undefined && (/[$_@%]/.test(ch) || /[a-zA-Z]/.test(ch));
  }
  return next !== undefined && /[$_@%/a-zA-Z]/.test(next);
}

/**
 * Skip `.class` / `#id` selector segments starting at `i`; segments may
 * hold `{$var}`-style interpolations. Returns the index after the last one.
 */
function parseSelectors(input: string, start: number): number {
  let i = start;
  while (i < input.length && (input[i] === '.' || input[i] === '#')) {
    i++;
    while (i < input.length) {
      if (/[a-zA-Z0-9_-]/.test(input[i])) {
        i++;
      } else if (input[i] === '{' && (input[i + 1] === '$' || input[i + 1] === '_' || input[i + 1] === '@')) {
        const braceStart = i;
        i += 2;
        while (i < input.length && /[\w.]/.test(input[i])) i++;
        if (input[i] === '}') {
          i++;
        } else {
          i = braceStart;
          break;
        }
      } else {
        break;
      }
    }
  }
  return i;
}

/**
 * End index of the HTML tag starting at the `<` at `start`, or -1 when the
 * runtime tokenizer would treat it as text.
 */
function htmlTagEnd(input: string, start: number): number {
  let j = start + 1;
  const isClose = input[j] === '/';
  if (isClose) j++;
  const tagStart = j;
  while (j < input.length && /[a-zA-Z0-9-]/.test(input[j])) j++;
  if (j === tagStart || !/[a-zA-Z]/.test(input[tagStart])) return -1;

  if (isClose) {
    while (j < input.length && /\s/.test(input[j])) j++;
    return input[j] === '>' ? j + 1 : -1;
  }

  // Attributes: quoted values may hold braces, which the runtime counts
  while (j < input.length) {
    while (j < input.length && /\s/.test(input[j])) j++;
    if (j >= input.length || input[j] === '>' || (input[j] === '/' && input[j + 1] === '>')) break;
    const nameStart = j;
    while (j < input.length && /[a-zA-Z0-9_\-:@]/.test(input[j])) j++;
    if (j === nameStart) break;
    if (input[j] !== '=') continue;
    j++;
    if (input[j] === '"' || input[j] === "'") {
      const quote = input[j];
      j++;
      let braceDepth = 0;
      while (j < input.length) {
        if (input[j] === '{') braceDepth++;
        else if (input[j] === '}') braceDepth--;
        else if (input[j] === quote && braceDepth <= 0) break;
        j++;
      }
      if (j < input.length) j++;
    } else {
      while (j < input.length && /[^\s>]/.test(input[j])) j++;
    }
  }
  if (input[j] === '/') j++;
  return input[j] === '>' ? j + 1 : -1;
}

/**
 * Check if a position in the string is inside an HTML attribute value.
 * Walks forward from start tracking quote context around = signs.
 */
function isInsideAttribute(text: string, pos: number): boolean {
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
 * single whole-line placeholder so Prettier cannot split them.
 */
export function replaceSpindleTokens(html: string): PlaceholderResult {
  const tokens: string[] = [];
  // A token may span lines (e.g. a template literal with a newline). The
  // per-line scan below cannot see it whole, so protect complete multiline
  // tokens first as single-line stand-ins and expand them again at the end.
  const multiline: string[] = [];
  let tag = 'SPML';
  while (html.includes(`{${tag}`)) tag += 'X';
  let source = '';
  let last = 0;
  for (const m of scanSpindleTokens(html)) {
    if (!m.token.includes('\n')) continue;
    source += html.slice(last, m.start) + `{${tag}${multiline.length}}`;
    multiline.push(m.token);
    last = m.end;
  }
  source += html.slice(last);
  const standIn = new RegExp(`\\{${tag}(\\d+)\\}`, 'g');
  const expand = (t: string) => t.replace(standIn, (_, n) => multiline[Number(n)]);
  const lines = source.split('\n');
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

  return { text: resultLines.join('\n'), tokens: tokens.map(expand) };
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
