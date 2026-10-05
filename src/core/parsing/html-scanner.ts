import { createCodeScanner } from './code-scanner.js';

/**
 * An HTML tag as Spindle's tokenizer reads it from passage markup.
 * Offsets are relative to the scanned text.
 */
export interface HtmlTag {
  /** Tag name as written (Spindle matches closing tags case-insensitively). */
  name: string;
  /**
   * `open` puts an element on Spindle's AST stack and `close` takes it off.
   * Void elements and self-closing tags (`<b/>`) are `void`: they hold no
   * children.
   */
  kind: 'open' | 'close' | 'void';
  start: number;
  end: number;
  /**
   * The attribute values of an opening or void tag as [start, end) offsets,
   * without their quotes. Spindle passes each value through interpolate()
   * when it renders the element.
   */
  values?: Array<[number, number]>;
}

export interface HtmlScan {
  tags: HtmlTag[];
  /**
   * Offset at which the scan gave up, or -1 if it read the whole text.
   * Tags from there on are unknown. See scanHtmlTags().
   */
  stoppedAt: number;
  /**
   * Offsets of the macros Spindle reads (their opening brace), up to
   * `stoppedAt`, so that callers can check their own macro parse against it.
   */
  macros: number[];
}

/**
 * Elements that never take children. Spindle 0.45.1 only treats br, col,
 * hr, img and wbr as void and puts any other tag, `<input>` included, on
 * its AST stack until a closing tag; later versions know all of these and
 * drop their closing tags. Using the larger set means an element is never
 * reported as open when some Spindle version closes it.
 */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const TAG_NAME_CHAR = /[a-zA-Z0-9-]/;
const LETTER = /[a-zA-Z]/;
const ATTR_NAME_CHAR = /[a-zA-Z0-9_\-:@]/;
/**
 * Spindle's `\s`, except for the no-break space: Spindle reads passages
 * from the story HTML's innerHTML, which serializes U+00A0 as `&nbsp;`, so
 * at runtime it is never whitespace inside a tag.
 */
const WHITESPACE = /[^\S ]/;
const SELECTOR_NAME_CHAR = /[a-zA-Z0-9_-]/;
const DISPLAY_NAME_CHAR = /[\w.]/;

/** Marks a construct the scan cannot follow; see scanHtmlTags(). */
const GIVE_UP = -2;

/**
 * For every `{`, the index of the `}` that a plain depth count from it
 * reaches, as Spindle 0.45.1's tokenizer finds the end of a macro or a
 * variable display (string literals are not skipped). -1 if none.
 */
function plainBraceMatches(input: string): Int32Array {
  const match = new Int32Array(input.length).fill(-1);
  const open: number[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '{') open.push(i);
    else if (input[i] === '}' && open.length > 0) match[open.pop()!] = i;
  }
  return match;
}

/**
 * Find the HTML tags in one passage's markup the way Spindle's tokenizer
 * (markup/tokenizer.ts) does, so that callers can rebuild the element
 * stack its AST builder keeps.
 *
 * The tokenizer reads the passage in one pass: `\{` and `\}` escapes,
 * `[[links]]`, macros and `{$…}`-style displays (with `.class#id`
 * prefixes) consume their text whole, and a `<` elsewhere starts a tag
 * when a letter follows (or `/` and a letter). Tags are therefore not seen
 * inside macro arguments, displays or links, but are seen everywhere else,
 * HTML comments and `<script>`/`<style>` bodies included. A tag that does
 * not end in `>` is text.
 *
 * Where Spindle versions read the markup differently, or following
 * Spindle would cost more than linear time, the scan stops and records the
 * offset in `stoppedAt`, so that callers draw no conclusions from the rest:
 *  - a macro or display whose closing brace depends on whether string
 *    literals are skipped (0.45.1 does not, later versions do);
 *  - a quoted attribute value containing braces that the two versions end
 *    at different quotes;
 *  - a tag inside a `{do}` body, which later versions keep as JavaScript
 *    text up to the first `{/do}`, or a `{do}` body whose `{/do}` 0.45.1
 *    reads as part of another token;
 *  - an even run of backslashes before a brace (`\\{`), where 0.45.1
 *    escapes the brace and later versions escape a backslash;
 *  - a link that never closes, or a tag that fails after reading
 *    attributes (`<a href = "x">`, `x <y and z.`): Spindle reads the text
 *    again from the character after `<`, which can take quadratic time.
 */
export function scanHtmlTags(text: string): HtmlScan {
  const n = text.length;
  const tags: HtmlTag[] = [];
  const macros: number[] = [];
  const code = createCodeScanner(text);
  const plain = plainBraceMatches(text);

  /**
   * `{do}` bodies as later versions read them: from the end of the `{do}`
   * to the start of the first `{/do}` after it, as [start, close].
   */
  const rawBodies: Array<[number, number]> = [];
  let doCloses: number[] | undefined;
  let nextDoClose = 0;
  const rawBody = (end: number) => {
    doCloses ??= [...text.matchAll(/\{\/do\s*\}/gi)].map(match => match.index);
    while (nextDoClose < doCloses.length && doCloses[nextDoClose] < end) nextDoClose++;
    if (nextDoClose < doCloses.length) rawBodies.push([end, doCloses[nextDoClose]]);
  };

  /**
   * The first offset before `limit` at which 0.45.1 and later versions read
   * a `{do}` body differently, or `limit`: a tag in the body, or the whole
   * body when 0.45.1 does not read its `{/do}` as a macro.
   */
  const rawBodyLimit = (limit: number): number => {
    if (rawBodies.length === 0) return limit;
    const macroStarts = new Set(macros);
    let t = 0;
    for (const [start, close] of rawBodies) {
      if (start >= limit) break;
      if (close < limit && !macroStarts.has(close)) {
        limit = start;
        break;
      }
      while (t < tags.length && tags[t].start < start) t++;
      if (t < tags.length && tags[t].start < Math.min(close, limit)) limit = tags[t].start;
    }
    return limit;
  };

  /** End of the brace-delimited token opening at `open`, or GIVE_UP. */
  const braceEnd = (open: number): number => {
    const close = code.closeBrace(open + 1);
    if (close !== plain[open]) return GIVE_UP;
    return close === -1 ? open + 1 : close + 1;
  };

  /**
   * End of the variable display opening at `open` whose sigil is at
   * `sigil`: `{$name.path}`, else a balanced `{$expr}`.
   */
  const displayEnd = (open: number, sigil: number): number => {
    let j = sigil + 1;
    while (j < n && DISPLAY_NAME_CHAR.test(text[j])) j++;
    return text[j] === '}' ? j + 1 : braceEnd(open);
  };

  /** Where scanning continues after the `{` at i: past the token it starts, or i + 1. */
  const afterBrace = (i: number): number => {
    let at = i + 1;
    const selectors = text[at] === '.' || text[at] === '#';
    if (selectors) {
      at = selectorsEnd(text, at);
      if (text[at] === ' ') at++;
    }
    const c = text[at];
    if (c === '$' || c === '_' || c === '@' || c === '%') return displayEnd(i, at);
    if (c === undefined) return i + 1;
    // A closing macro takes no selectors.
    if (LETTER.test(c) || (c === '/' && !selectors)) {
      const end = braceEnd(i);
      if (end > i + 1) {
        macros.push(i);
        if (/^do$/i.test(text.slice(at, end - 1).trim().split(/\s/)[0])) rawBody(end);
      }
      return end;
    }
    return i + 1;
  };

  /**
   * Read the tag at the `<` at i. Returns where scanning continues, with
   * the tag (if any) pushed; i + 1 when it is text; or GIVE_UP.
   */
  const readTag = (i: number): number => {
    let j = i + 1;
    const isClose = text[j] === '/';
    if (isClose) j++;
    const nameStart = j;
    while (j < n && TAG_NAME_CHAR.test(text[j])) j++;
    const name = text.slice(nameStart, j);
    if (!name || !LETTER.test(name[0])) return i + 1;
    const isVoid = VOID_ELEMENTS.has(name.toLowerCase());

    if (isClose) {
      while (j < n && WHITESPACE.test(text[j])) j++;
      if (text[j] !== '>') return i + 1;
      if (!isVoid) tags.push({ name, kind: 'close', start: i, end: j + 1 });
      return j + 1;
    }

    const attrs = readAttributes(j);
    if (attrs.end === GIVE_UP) return GIVE_UP;
    j = attrs.end;
    let selfClosing = isVoid;
    if (text[j] === '/') {
      selfClosing = true;
      j++;
    }
    if (text[j] === '>') {
      tags.push({ name, kind: selfClosing ? 'void' : 'open', start: i, end: j + 1, values: attrs.values });
      return j + 1;
    }
    return attrs.count > 0 ? GIVE_UP : i + 1;
  };

  /**
   * Spindle's parseHtmlAttributes() from j: where the attributes end, how
   * many there are and where their values lie.
   */
  const readAttributes = (j: number): { end: number; count: number; values: Array<[number, number]> } => {
    let count = 0;
    const values: Array<[number, number]> = [];
    while (j < n) {
      while (j < n && WHITESPACE.test(text[j])) j++;
      if (j >= n || text[j] === '>' || (text[j] === '/' && text[j + 1] === '>')) break;
      const nameStart = j;
      while (j < n && ATTR_NAME_CHAR.test(text[j])) j++;
      if (j === nameStart) break;
      count++;
      if (text[j] !== '=') continue; // boolean attribute
      j++;
      const quote = text[j];
      if (quote === '"' || quote === "'") {
        const close = quotedValueEnd(j + 1, quote);
        if (close === GIVE_UP) return { end: GIVE_UP, count, values };
        values.push([j + 1, close]);
        j = close < n ? close + 1 : close;
      } else {
        const start = j;
        while (j < n && !WHITESPACE.test(text[j]) && text[j] !== '>') j++;
        values.push([start, j]);
      }
    }
    return { end: j, count, values };
  };

  /**
   * The closing quote of an attribute value starting at `from` (n if none).
   * Spindle 0.45.1 counts braces and ends the value at a quote outside them;
   * later versions skip balanced `{…}` and end at the next quote otherwise.
   */
  const quotedValueEnd = (from: number, quote: string): number => {
    let depth = 0;
    let sawBrace = false;
    let k = from;
    for (; k < n; k++) {
      const c = text[k];
      if (c === '{') {
        depth++;
        sawBrace = true;
      } else if (c === '}') {
        depth--;
        sawBrace = true;
      } else if (c === quote && depth <= 0) {
        break;
      }
    }
    if (!sawBrace) return k;

    let d = from;
    while (d < n) {
      if (text[d] === '{') {
        const close = code.closeBrace(d + 1);
        if (close !== -1) {
          d = close + 1;
          continue;
        }
      } else if (text[d] === quote) {
        break;
      }
      d++;
    }
    return d === k ? k : GIVE_UP;
  };

  let i = 0;
  let stoppedAt = -1;
  while (i < n) {
    const c = text[i];
    let next: number;
    if (c === '\\') {
      // A run of backslashes: 0.45.1 escapes a brace after it, later
      // versions only after an odd run.
      let k = i + 1;
      while (text[k] === '\\') k++;
      if (text[k] === '{' || text[k] === '}') next = (k - i) % 2 === 1 ? k + 1 : GIVE_UP;
      else next = k;
    } else if (c === '[' && text[i + 1] === '[') {
      next = linkEnd(text, i);
    } else if (c === '{') {
      next = afterBrace(i);
    } else if (c === '<') {
      next = readTag(i);
    } else {
      next = i + 1;
    }
    if (next === GIVE_UP) {
      stoppedAt = i;
      break;
    }
    i = next;
  }

  // Where the versions read a {do} body differently, stop there
  const limit = rawBodyLimit(stoppedAt === -1 ? n : stoppedAt);
  if (limit === stoppedAt || limit === n) return { tags, stoppedAt, macros };
  return {
    tags: tags.filter(tag => tag.start < limit),
    stoppedAt: limit,
    macros: macros.filter(at => at < limit),
  };
}

/**
 * The end of the `.class#id` selectors starting at i, as Spindle's
 * parseSelectors() reads them: names of [A-Za-z0-9_-] and `{$var}`,
 * `{_var}` or `{@var}` interpolations.
 */
function selectorsEnd(text: string, i: number): number {
  const n = text.length;
  while (i < n && (text[i] === '.' || text[i] === '#')) {
    i++;
    while (i < n) {
      if (SELECTOR_NAME_CHAR.test(text[i])) {
        i++;
      } else if (text[i] === '{' && (text[i + 1] === '$' || text[i + 1] === '_' || text[i + 1] === '@')) {
        let j = i + 2;
        while (j < n && DISPLAY_NAME_CHAR.test(text[j])) j++;
        if (text[j] !== '}') break;
        i = j + 1;
      } else {
        break;
      }
    }
  }
  return i;
}

/**
 * The end of the `[[link]]` opening at i, with nested `[[…]]` counted, or
 * GIVE_UP when it never closes (Spindle then reads on from i + 2, and
 * following it there can take quadratic time). Selectors after `[[` hold
 * no brackets, so the count can start right after the `[[`.
 */
function linkEnd(text: string, i: number): number {
  const n = text.length;
  let depth = 1;
  let j = i + 2;
  while (j < n) {
    if (text[j] === '[' && text[j + 1] === '[') {
      depth++;
      j += 2;
    } else if (text[j] === ']' && text[j + 1] === ']') {
      if (--depth === 0) return j + 2;
      j += 2;
    } else {
      j++;
    }
  }
  return GIVE_UP;
}

/**
 * The attribute values of the tags Spindle reads in a Twee document, as
 * sorted [start, end) offsets: scanHtmlTags() run on each passage on its own
 * (a line starting with `::` starts the next one). Where a scan stops, the
 * values from there on are unknown and left out.
 */
export function attributeValueSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  if (!text.includes('<')) return spans;
  const headers = [...text.matchAll(/^::.*$/gm)];
  const scan = (from: number, to: number) => {
    const content = text.slice(from, to);
    if (!content.includes('<')) return;
    for (const tag of scanHtmlTags(content).tags) {
      for (const [start, end] of tag.values ?? []) spans.push([from + start, from + end]);
    }
  };
  let from = 0;
  for (const header of headers) {
    scan(from, header.index);
    from = header.index + header[0].length;
  }
  scan(from, text.length);
  return spans;
}

/** Whether the character at `offset` lies in an attribute value; see attributeValueSpans(). */
export function inAttributeValue(text: string, offset: number): boolean {
  return attributeValueSpans(text).some(([start, end]) => start <= offset && offset < end);
}
