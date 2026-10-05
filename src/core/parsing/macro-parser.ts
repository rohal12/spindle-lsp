import type { MacroNode, Position, Range } from '../types.js';
import { createCodeScanner, type BraceReading } from './code-scanner.js';
import { attributeValueSpans, policyFor, scanHtmlTags, type HtmlTag } from './html-scanner.js';
import { bracketLinkEnd } from './link-parser.js';
import { HAS_PASSAGE_HEADER, isMarkupPassage, maskNonMarkupPassages, passageBodies, type PassageRole } from './passage-parser.js';

export { createCodeScanner, scanBalancedBrace, type CodeScanner } from './code-scanner.js';

/**
 * Regex for variable interpolation: {$var}, {_var}, {@var}
 * These must be neutralized before macro parsing to avoid false matches.
 */
const variableInterpolationRegex = /(?<!\\)\{([$_@%][A-Za-z_$][\w$.]*)\}/g;

/**
 * Regex source for the CSS selectors that can follow the opening brace of a
 * macro or variable display (`{.red#alert …}`), as Spindle's tokenizer reads
 * them in parseSelectors(): `.class` and `#id` segments with nothing between
 * them, each name made of [A-Za-z0-9_-] and `{$var}` / `{_var}` / `{@var}`
 * interpolations (and possibly empty). It has no capturing groups.
 *
 * Spindle takes a macro name only after the selectors and exactly one space:
 * a letter directly after them would still belong to the last segment. So
 * write the prefix of a macro head as `(?:${SELECTOR_PATTERN} )?`; the space
 * keeps a regex from backtracking into a class name and reading its tail as
 * the macro name (`{.hero-name $x}` is a variable display, not `{e $x}`).
 */
export const SELECTOR_PATTERN = String.raw`(?:[.#](?:[\w-]|\{[$_@][\w.]*\})*)+`;

/**
 * Spindle macro head: the opening brace and what precedes the macro name.
 * The name, the arguments and the closing brace are read from the balanced
 * brace by parseMacrosInPassage(), because Spindle's tokenizer takes the
 * text between the braces whole: the name is everything up to the first
 * whitespace (`{a=b}`, `{if($x)}` and `{x{$y}}` are macros named `a=b`,
 * `if($x)` and `x{$y}`), after the selectors and one space for an opener
 * (which must start with a letter), right after the slash for a closer
 * (which takes any text, also none: `{/}` and `{/ x}` close a macro named
 * ``).
 * Groups:
 *   1 = closing slash (/) — present for closing macros
 *   2 = CSS prefix (e.g. ".red#alert")
 */
const macroHeadRegex = new RegExp(
  String.raw`(?<!\\)\{(?:(\/)|(?:(${SELECTOR_PATTERN}) )?(?=[A-Za-z]))`,
  'gi',
);

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
 * same-length placeholder text in the arguments and the brace scan,
 * preserving character offsets. Macro heads are matched in the original
 * text, since selectors may contain such interpolations (`{.a{$k} if …}`).
 *
 * Selectors followed by anything but one space and a macro name make no
 * macro: `{.cls $var}` (also `_`, `@`, `%`) is a variable display with a
 * class, as in Spindle's tokenizer, and `{.a .b if}` is text.
 *
 * A macro ends at its balanced closing brace, so object literals and strings
 * in the arguments are kept whole. A macro whose brace never closes is text,
 * and scanning resumes right after its opening brace.
 *
 * A macro inside an HTML attribute value is text too: Spindle's tokenizer
 * reads the value as part of the tag, and interpolate() outputs everything
 * but `{$…}`-style expressions there as written (rohal12/spindle#225). See
 * attributeValueSpans().
 */
export function parseMacros(text: string, reading: BraceReading = {}): MacroNode[] {
  // Spindle renders each passage on its own: a macro never spans a header
  if (!HAS_PASSAGE_HEADER.test(text)) return parseMacrosInPassage(text, reading);
  const macros: MacroNode[] = [];
  for (const body of passageBodies(text)) {
    for (const macro of parseMacrosInPassage(text.slice(body.start, body.end), reading)) {
      macro.id = macros.length;
      macro.range.start.line += body.line;
      macro.range.end.line += body.line;
      macros.push(macro);
    }
  }
  return macros;
}

function parseMacrosInPassage(text: string, reading: BraceReading): MacroNode[] {
  // Replace variable interpolation with same-length spaces to preserve offsets
  const cleaned = text.replace(variableInterpolationRegex, (match) => {
    return ' '.repeat(match.length);
  });

  const lineStarts = buildLineStarts(text);
  const scanner = createCodeScanner(cleaned, reading);
  const macros: MacroNode[] = [];
  let id = 0;

  const attributeValues = attributeValueSpans(text, reading);
  // The spans are sorted and disjoint (one tag's values follow another's)
  const inAttributeValue = (offset: number): boolean => {
    let low = 0;
    let high = attributeValues.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const [start, end] = attributeValues[mid];
      if (offset < start) high = mid - 1;
      else if (offset >= end) low = mid + 1;
      else return true;
    }
    return false;
  };

  // Reset regex state (global regex)
  macroHeadRegex.lastIndex = 0;
  let match: RegExpExecArray | null;

  // Spindle tokenizes a complete bracket link as one token, so a macro head
  // inside it is label text. Whichever of `[[` and a macro head comes first
  // wins; an unclosed link is text.
  // A `[[` inside an HTML attribute value starts no link: the tag consumes
  // the value whole.
  const nextLinkStart = (from: number): number => {
    let at = text.indexOf('[[', from);
    while (at !== -1 && inAttributeValue(at)) at = text.indexOf('[[', at + 1);
    return at;
  };
  let linkStart = nextLinkStart(0);

  while ((match = macroHeadRegex.exec(text)) !== null) {
    const matchStart = match.index;
    let insideLink = false;
    while (linkStart !== -1 && linkStart < matchStart) {
      const end = bracketLinkEnd(text, linkStart);
      if (end === -1) {
        linkStart = nextLinkStart(linkStart + 2);
      } else if (end > matchStart) {
        macroHeadRegex.lastIndex = end;
        linkStart = nextLinkStart(end);
        insideLink = true;
        break;
      } else {
        linkStart = nextLinkStart(end);
      }
    }
    if (insideLink) continue;
    if (inAttributeValue(matchStart)) {
      // Text; a macro after the value may start inside this one's braces
      macroHeadRegex.lastIndex = matchStart + 1;
      continue;
    }
    const closeIdx = scanner.closeBrace(matchStart + 1);
    if (closeIdx === -1) {
      // Unclosed macro — treat as text
      macroHeadRegex.lastIndex = matchStart + 1;
      continue;
    }
    const matchEnd = closeIdx + 1;
    macroHeadRegex.lastIndex = matchEnd;
    if (linkStart !== -1 && linkStart < matchEnd) linkStart = nextLinkStart(matchEnd);

    const closeSlash = match[1];
    const cssPrefix = match[2] || '';
    // The name runs to the first whitespace (or the closing brace), in the
    // source text: a `{$var}` interpolation inside it belongs to the name.
    const nameStart = matchStart + match[0].length;
    const whitespace = /\s/.exec(text.slice(nameStart, closeIdx));
    const nameEnd = whitespace ? nameStart + whitespace.index : closeIdx;
    const macroName = text.slice(nameStart, nameEnd);
    // Arguments start after the whitespace following the name and run up to
    // the closing brace.
    const rawArgs = cleaned.slice(nameEnd, closeIdx).replace(/^\s+/, '');

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
 * An HTML tag as an event on Spindle's AST stack. buildAST (markup/ast.ts)
 * keeps HTML elements and block macros on one stack, so `{wrap}<div>{/wrap}`
 * throws at the `{/wrap}`: a `<div>` is on top.
 */
export interface ElementEvent {
  /**
   * Where the event takes effect: the `>` of an opening tag, the `<` of a
   * closing tag, and for `stop` the first place the reading is not certain.
   */
  position: Position;
  /**
   * `stop`: from here on the language server does not know how Spindle
   * reads the markup (see collectElementEvents()), so macros are paired by
   * themselves and element errors are not reported.
   */
  kind: 'open' | 'close' | 'stop';
  /** The tag name, lowercase (buildAST compares tag names that way). */
  name: string;
  /** The tag as written, for messages. */
  tag: string;
  /** The whole tag. */
  range: Range;
}

/** The elements of a document for pairMacros(), and the SP102 findings it adds. */
export interface ElementStructure {
  /** In document order. */
  events: ElementEvent[];
  /** Where buildAST throws on the HTML structure, first one per passage. */
  errors: Array<{ range: Range; message: string }>;
}

type StackEntry = { key: string; macro: MacroNode } | { key: string; event: ElementEvent };

const isBefore = (a: Position, b: Position) => a.line < b.line || (a.line === b.line && a.character <= b.character);

/**
 * Pair opening and closing macros the way Spindle's AST builder nests them.
 *
 * Block macros (isBlock(name) is true) and, when `elements` is given, HTML
 * elements share a single stack, and Spindle's buildAST accepts a closing
 * macro or tag only when its container is on top of that stack: `{/name}`
 * over anything else throws "Expected {/other} but found {/name}" and the
 * passage is not rendered. A pairing therefore pairs a closer with the
 * container on top. Where the closer does not match, it is the closer
 * Spindle rejects, and the container(s) above the one it names decide how
 * the rest of the passage reads:
 *
 *  - If one of them is closed later in the passage, the containers cross
 *    (`{wrap}{if}{/wrap}{/if}`, `{wrap}<div>{/wrap}</div>`): the closer is
 *    the error and stays unpaired, the stack is unchanged, and the later
 *    closer pairs as buildAST would pair it.
 *  - Otherwise their closers are missing (`{if}{for}{/if}`): the
 *    containers above the named one are left unclosed and the closer pairs
 *    with its opener.
 *
 * A closing macro with no open container of its name stays unpaired and
 * disturbs nothing, like the "Unexpected closing" Spindle throws.
 *
 * `passageStartLines` lists the header lines of the passages in the text.
 * Each passage is rendered on its own, so the stack is reset at every
 * passage boundary and containers never pair across passages. When omitted,
 * the whole text is treated as one passage.
 *
 * With `elements`, the first place in each passage where buildAST throws on
 * the HTML structure is added to `elements.errors` (a closing tag with
 * nothing or something else on top, a closing macro over an open element,
 * elements left open at the end), and each macro's `element` is set to the
 * element it sits directly in.
 *
 * Unmatched macros keep pair = -1.
 */
export function pairMacros(
  macros: MacroNode[],
  isBlock: (name: string) => boolean,
  passageStartLines: number[] = [],
  elements?: ElementStructure,
): void {
  const boundaries = [...passageStartLines].sort((a, b) => a - b);
  const events = elements?.events ?? [];

  // The macros and the element events in document order; an event comes
  // first where it takes effect at the macro's own position (`<b>{if}`).
  type Item = { macro: MacroNode } | { event: ElementEvent };
  const items: Item[] = [];
  for (let m = 0, e = 0; m < macros.length || e < events.length;) {
    if (e < events.length && (m >= macros.length || isBefore(events[e].position, macros[m].range.start))) {
      items.push({ event: events[e++] });
    } else {
      items.push({ macro: macros[m++] });
    }
  }
  const lineOf = (item: Item) => ('macro' in item ? item.macro.range.start.line : item.event.position.line);

  let nextBoundary = 0;
  let stack: StackEntry[] = [];
  // Closers still to come in the current passage, by kind and lowercase name
  let pending = new Map<string, number>();
  // buildAST has thrown in this passage; the reading stopped being certain
  let thrown = false;
  let stopped = false;
  let segmentStart = 0;

  const report = (range: Range, message: string) => {
    if (elements && !thrown && !stopped) elements.errors.push({ range, message });
  };
  const finishPassage = () => {
    if (!elements || thrown || stopped) return;
    // buildAST throws for the innermost node still open at the end, and each
    // element left open needs its closing tag.
    for (const entry of stack) {
      if ('event' in entry) report(entry.event.range, `unclosed <${entry.event.tag}>`);
    }
  };

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    // Entering a new passage: anything still open stays unmatched.
    let crossed = false;
    while (nextBoundary < boundaries.length && lineOf(item) >= boundaries[nextBoundary]) {
      nextBoundary++;
      crossed = true;
    }
    if (crossed || index === 0) {
      if (crossed) {
        finishPassage();
        stack = [];
        thrown = false;
        stopped = false;
      }
      segmentStart = index;
      let segmentEnd = index;
      while (
        segmentEnd < items.length &&
        (nextBoundary >= boundaries.length || lineOf(items[segmentEnd]) < boundaries[nextBoundary])
      ) segmentEnd++;
      pending = new Map();
      for (let i = segmentStart; i < segmentEnd; i++) {
        const other = items[i];
        const key = 'event' in other
          ? (other.event.kind === 'close' ? `e:${other.event.name}` : '')
          : (!other.macro.open && isBlock(other.macro.name) ? `m:${other.macro.name.toLowerCase()}` : '');
        if (key) pending.set(key, (pending.get(key) ?? 0) + 1);
      }
    }

    if ('event' in item) {
      const event = item.event;
      if (event.kind === 'stop') {
        // Whatever the elements did to the stack is unknown from here on
        stack = stack.filter(entry => 'macro' in entry);
        stopped = true;
        continue;
      }
      if (stopped) continue;
      if (event.kind === 'open') {
        stack.push({ key: `e:${event.name}`, event });
        continue;
      }

      const key = `e:${event.name}`;
      pending.set(key, (pending.get(key) ?? 1) - 1);
      const top = stack[stack.length - 1];
      if (!top) {
        report(event.range, `unexpected closing </${event.tag}>`);
        thrown = true;
        continue;
      }
      if (top.key !== key) {
        report(
          event.range,
          'macro' in top
            ? `expected {/${top.macro.name}} but found </${event.tag}>`
            : `expected </${top.event.tag}> but found </${event.tag}>`,
        );
        thrown = true;
      }
      // Recovery, as for macros: an element above a closer's own that is
      // closed later makes the closer the error; otherwise close it
      let target = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].key === key) {
          target = i;
          break;
        }
      }
      if (target === -1) continue;
      let crossing = false;
      for (let i = target + 1; i < stack.length; i++) {
        if ((pending.get(stack[i].key) ?? 0) > 0) {
          crossing = true;
          break;
        }
      }
      if (!crossing) stack.length = target;
      continue;
    }

    const macro = item.macro;
    const top = stack[stack.length - 1];
    // (nothing after the first place buildAST throws is rendered)
    if (!stopped && !thrown) macro.element = top && 'event' in top ? top.event.tag : undefined;

    if (!isBlock(macro.name)) {
      // Spindle takes a closer only for the container on top: any other
      // closing macro throws
      if (!macro.open) thrown = true;
      continue;
    }

    const name = macro.name.toLowerCase();
    const key = `m:${name}`;
    if (macro.open) {
      stack.push({ key, macro });
      continue;
    }

    pending.set(key, (pending.get(key) ?? 1) - 1);

    // The nearest open container of this name
    let target = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].key === key) {
        target = i;
        break;
      }
    }
    if (target === -1) {
      thrown = true;
      continue;
    }

    // A container above it that is closed later: the containers cross
    let crossing = false;
    for (let i = target + 1; i < stack.length; i++) {
      if ((pending.get(stack[i].key) ?? 0) > 0) {
        crossing = true;
        break;
      }
    }
    if (crossing) {
      if ('macro' in top) {
        macro.expected = top.macro.name;
      } else {
        macro.expectedElement = top.event.tag;
        report(macro.range, `expected </${top.event.tag}> but found {/${macro.name}}`);
      }
      thrown = true;
      continue;
    }

    if (target !== stack.length - 1) {
      // Containers above it are never closed: buildAST throws here
      if ('event' in top) report(macro.range, `expected </${top.event.tag}> but found {/${macro.name}}`);
      thrown = true;
    }
    const opener = stack[target] as { key: string; macro: MacroNode };
    opener.macro.pair = macro.id;
    macro.pair = opener.macro.id;
    // Containers opened inside it but never closed remain unmatched
    stack.length = target;
  }
  finishPassage();
}

/** Line/character offsets of a document, for the position helpers. */
function positionOf(offset: number, lineStarts: number[]): Position {
  return offsetToPosition(offset, lineStarts);
}

/**
 * The element events of a document's passages for pairMacros(), the
 * way Spindle's tokenizer reads the HTML tags (scanHtmlTags()), up to the
 * first place where the reading is not certain. There the events end with a
 * `stop`: where the scanner gave up because Spindle versions disagree or
 * following them would be quadratic, a tag inside what the macro parser
 * took for a macro, and a macro Spindle does not read as one (such as `{if}`
 * inside a link, which it reads as part of the link). Macros after that are
 * judged by macros alone, as if there were no HTML. Passages Spindle does not
 * tokenize as markup have no events.
 */
export function collectElementEvents(
  text: string,
  macros: MacroNode[],
  passages: Array<PassageRole & { range: Range }>,
  reading: BraceReading = {},
): ElementEvent[] {
  if (!text.includes('<')) return [];

  const lineStarts = buildLineStarts(text);
  const lineOffset = (line: number) => lineStarts[line] ?? text.length;
  const offsetOf = (position: Position) => lineOffset(position.line) + position.character;
  const ordered = [...passages].sort((a, b) => a.range.start.line - b.range.start.line);
  const events: ElementEvent[] = [];
  let m = 0;

  for (const passage of ordered) {
    const contentStart = lineOffset(passage.range.start.line + 1);
    const contentEnd = lineOffset(passage.range.end.line + 1);
    while (m < macros.length && offsetOf(macros[m].range.start) < contentStart) m++;
    const first = m;
    while (m < macros.length && offsetOf(macros[m].range.start) < contentEnd) m++;

    const content = text.slice(contentStart, contentEnd);
    if (!content.includes('<') || !isMarkupPassage(passage)) continue;

    const scan = scanHtmlTags(content, policyFor(reading));
    const { tags } = scan;
    const macroStart = (k: number) => offsetOf(macros[k].range.start) - contentStart;
    const at = (relative: number) => positionOf(contentStart + relative, lineStarts);
    const tagRange = (tag: HtmlTag): Range => ({ start: at(tag.start), end: at(tag.end) });

    // The reading is certain up to `certainUntil`: where the scanner gave
    // up, or the first macro Spindle reads that the macro parser did not find.
    let certainUntil = scan.stoppedAt === -1 ? Infinity : scan.stoppedAt;
    const parsed = new Set<number>();
    for (let k = first; k < m; k++) parsed.add(macroStart(k));
    const unparsed = scan.macros.find(offset => !parsed.has(offset));
    if (unparsed !== undefined) certainUntil = Math.min(certainUntil, unparsed);

    const stop = (relative: number) => {
      events.push({ position: at(relative), kind: 'stop', name: '', tag: '', range: { start: at(relative), end: at(relative) } });
    };

    let t = 0;
    let s = 0;
    let lastMacroEnd = -1;
    /** Apply the tags that take effect up to `until`; the offset where reading stops, or -1. */
    const applyTags = (until: number): number => {
      for (; t < tags.length; t++) {
        const tag = tags[t];
        const effective = tag.kind === 'close' ? tag.start : tag.end;
        if (effective > until) break;
        if (tag.start >= certainUntil) return tag.start;
        // A tag inside a macro: the scanner read text the parser took as a macro
        if (tag.start < lastMacroEnd) return tag.start;
        if (tag.kind === 'void') continue;
        events.push({
          position: at(effective),
          kind: tag.kind,
          name: tag.name.toLowerCase(),
          tag: tag.name,
          range: tagRange(tag),
        });
      }
      return -1;
    };

    let stoppedAt = -1;
    for (let k = first; k < m && stoppedAt === -1; k++) {
      const start = macroStart(k);
      stoppedAt = applyTags(start);
      if (stoppedAt !== -1) break;
      if (start >= certainUntil) {
        stoppedAt = start;
        break;
      }
      // A macro Spindle does not read, e.g. one inside a link
      while (s < scan.macros.length && scan.macros[s] < start) s++;
      if (scan.macros[s] !== start) {
        stoppedAt = start;
        break;
      }
      lastMacroEnd = offsetOf(macros[k].range.end) - contentStart;
    }
    if (stoppedAt === -1) stoppedAt = applyTags(Infinity);
    if (stoppedAt === -1 && certainUntil !== Infinity) stoppedAt = content.length;
    if (stoppedAt !== -1) stop(stoppedAt);
  }
  return events;
}

/**
 * The macros of a whole document as Spindle runs them, with the findings
 * about the HTML structure: the bodies of passages it does not tokenize as
 * markup are masked first (see maskNonMarkupPassages()), and containers
 * (blocks and HTML elements) are paired per passage by pairMacros(). The
 * `errors` are where buildAST throws on the elements (SP102).
 */
export function parseDocumentStructure(
  text: string,
  passages: Array<PassageRole & { range: Range }>,
  isBlock: (name: string) => boolean,
  options: DocumentMacroOptions = {},
): { macros: MacroNode[]; errors: ElementStructure['errors'] } {
  const masked = maskedDocument(text, passages, options);
  const macros = parseMacros(masked, options);
  const elements: ElementStructure = { events: collectElementEvents(masked, macros, passages, options), errors: [] };
  pairMacros(macros, isBlock, passages.map(p => p.range.start.line), elements);
  return { macros, errors: elements.errors };
}

/** The span of a macro's name within its head (`{`, closing slash and selector prefix excluded). */
export function macroNameRange(macro: MacroNode): Range {
  const offset = 1 + (macro.open ? 0 : 1) + (macro.cssPrefix ? macro.cssPrefix.length + 1 : 0);
  const { line, character } = macro.range.start;
  return {
    start: { line, character: character + offset },
    end: { line, character: character + offset + macro.name.length },
  };
}

/**
 * The macros of a whole document as Spindle runs them: the bodies of passages
 * it does not tokenize as markup are masked first (see
 * maskNonMarkupPassages()), and, when `isBlock` is given, containers are
 * paired per passage by pairMacros() together with the HTML elements they
 * share Spindle's stack with. Every consumer that reads macros from a
 * document, rather than from one passage's markup, goes through here.
 */
export function parseDocumentMacros(
  text: string,
  passages: Array<PassageRole & { range: Range }>,
  isBlock?: (name: string) => boolean,
  options: DocumentMacroOptions = {},
): MacroNode[] {
  if (isBlock) return parseDocumentStructure(text, passages, isBlock, options).macros;
  return parseMacros(maskedDocument(text, passages, options), options);
}

/** Version-dependent reading of a document's markup (`SpindleCapabilities`). */
export interface DocumentMacroOptions extends BraceReading {
  /** Spindle >= 0.50.1: the body of a `{do}` is JavaScript text, not markup. */
  rawDoBodies?: boolean;
}

function maskedDocument(
  text: string,
  passages: Array<PassageRole & { range: Range }>,
  options: DocumentMacroOptions,
): string {
  const masked = maskNonMarkupPassages(text, passages);
  return options.rawDoBodies ? maskRawDoBodies(masked, options) : masked;
}

/**
 * Blank the bodies of `{do}` macros, keeping offsets and line breaks, the way
 * Spindle >= 0.50.1's tokenizer keeps them as JavaScript text: from the end
 * of a `{do}` to the first `{/do}` after it (which is then a macro). A `{do}`
 * with no `{/do}` after it has an ordinary body.
 */
export function maskRawDoBodies(text: string, reading: BraceReading = {}): string {
  if (!/\{[^}]*do/i.test(text)) return text;
  let masked = text;
  let skipUntil = -1;
  const lineStarts = buildLineStarts(text);
  for (const macro of parseMacros(text, reading)) {
    const start = lineStarts[macro.range.start.line] + macro.range.start.character;
    if (start < skipUntil || !macro.open || macro.name.toLowerCase() !== 'do') continue;
    const bodyStart = lineStarts[macro.range.end.line] + macro.range.end.character;
    const closer = /\{\/do\s*\}/gi;
    closer.lastIndex = bodyStart;
    const found = closer.exec(text);
    if (!found) continue;
    skipUntil = found.index;
    masked = masked.slice(0, bodyStart) + masked.slice(bodyStart, found.index).replace(/[^\r\n]/g, ' ') + masked.slice(found.index);
  }
  return masked;
}

/** A macro head's name as written in source, with the span of just the name. */
export interface MacroHeadName {
  name: string;
  closing: boolean;
  range: Range;
}

/**
 * Passage-scoped closer pairing for {@link macroHeadNames}: the passages of
 * the document, whose bodies are masked when Spindle does not tokenize them
 * as markup (see maskNonMarkupPassages()) and which bound each closer's
 * container.
 */
export interface MacroHeadPairing extends DocumentMacroOptions {
  isBlock: (name: string) => boolean;
  passages: Array<PassageRole & { range: Range }>;
}

/**
 * The macro-head names of a document, delimited by the shared macro grammar
 * (selector prefixes, hyphenated names, `{/name}` closers, attribute values
 * and unclosed heads excluded). Widget navigation and rename use this so
 * their notion of a call matches what Spindle's tokenizer executes.
 */
export function macroHeadNames(text: string, pairing?: MacroHeadPairing): MacroHeadName[] {
  const macros = pairing
    ? parseDocumentMacros(text, pairing.passages, pairing.isBlock, pairing)
    : parseMacros(text);
  return macros
    // Spindle rejects a closer with no open container of its name in its
    // passage ("Unexpected closing"), so that is no call. A closer that
    // crosses another container (`{wrap}{if}{/wrap}{/if}`) is the closer of
    // an open container, written out of order: it stays with its widget.
    .filter((macro) => !pairing || macro.open || !pairing.isBlock(macro.name)
      || macro.pair !== -1 || macro.expected !== undefined || macro.expectedElement !== undefined)
    .map((macro) => {
    const skip = 1 + (macro.open ? (macro.cssPrefix ? macro.cssPrefix.length + 1 : 0) : 1);
    const { start } = macro.range;
    return {
      name: macro.name,
      closing: !macro.open,
      range: {
        start: { line: start.line, character: start.character + skip },
        end: { line: start.line, character: start.character + skip + macro.name.length },
      },
    };
  });
}

/** The macro-head name containing `position`, if any. */
export function macroHeadNameAt(
  text: string,
  position: { line: number; character: number },
  pairing?: MacroHeadPairing,
): MacroHeadName | null {
  for (const head of macroHeadNames(text, pairing)) {
    const { start, end } = head.range;
    if (start.line === position.line && position.character >= start.character && position.character <= end.character) {
      return head;
    }
  }
  return null;
}
