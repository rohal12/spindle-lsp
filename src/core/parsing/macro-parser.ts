import type { MacroNode, Range } from '../types.js';
import { createCodeScanner } from './code-scanner.js';
import { attributeValueSpans } from './html-scanner.js';
import { bracketLinkEnd } from './link-parser.js';
import { HAS_PASSAGE_HEADER, maskNonMarkupPassages, passageBodies, type PassageRole } from './passage-parser.js';

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
 * Spindle macro head: the opening brace up to the end of the macro name.
 * The arguments and the closing brace are found by createCodeScanner().
 * Closing macros take no selectors. The name ends at whitespace, the closing
 * brace or a `{$var}`-style interpolation (blanked to spaces for the
 * arguments).
 * Groups:
 *   1 = closing slash (/) — present for closing macros
 *   2 = CSS prefix (e.g. ".red#alert")
 *   3 = macro name
 */
const macroHeadRegex = new RegExp(
  String.raw`(?<!\\)\{(?:(\/)|(${SELECTOR_PATTERN}) )?([A-Za-z][\w-]*)(?=[\s}]|\{[$_@%][A-Za-z_$][\w$.]*\})`,
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
export function parseMacros(text: string): MacroNode[] {
  // Spindle renders each passage on its own: a macro never spans a header
  if (!HAS_PASSAGE_HEADER.test(text)) return parseMacrosInPassage(text);
  const macros: MacroNode[] = [];
  for (const body of passageBodies(text)) {
    for (const macro of parseMacrosInPassage(text.slice(body.start, body.end))) {
      macro.id = macros.length;
      macro.range.start.line += body.line;
      macro.range.end.line += body.line;
      macros.push(macro);
    }
  }
  return macros;
}

function parseMacrosInPassage(text: string): MacroNode[] {
  // Replace variable interpolation with same-length spaces to preserve offsets
  const cleaned = text.replace(variableInterpolationRegex, (match) => {
    return ' '.repeat(match.length);
  });

  const lineStarts = buildLineStarts(text);
  const scanner = createCodeScanner(cleaned);
  const macros: MacroNode[] = [];
  let id = 0;

  const attributeValues = attributeValueSpans(text);
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
 * Block macros (isBlock(name) is true) share a single stack, and Spindle's
 * buildAST (markup/ast.ts) accepts a closing macro only when its container
 * is on top of that stack: `{/name}` over anything else throws "Expected
 * {/other} but found {/name}" and the passage is not rendered. A pairing
 * therefore pairs a closer with the container on top. Where the closer
 * does not match, it is the closer Spindle rejects, and the container(s)
 * above the one it names decide how the rest of the passage reads:
 *
 *  - If one of them is closed later in the passage, the containers cross
 *    (`{wrap}{if}{/wrap}{/if}`): the closer is the error and stays
 *    unpaired, the stack is unchanged, and the later closer pairs as
 *    buildAST would pair it.
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

  // Closers still to come in the current passage, by lowercase name
  let pending = new Map<string, number>();
  let segmentEnd = 0;
  const countClosers = (from: number, until: number) => {
    pending = new Map();
    for (let i = from; i < until; i++) {
      const macro = macros[i];
      if (macro.open || !isBlock(macro.name)) continue;
      const name = macro.name.toLowerCase();
      pending.set(name, (pending.get(name) ?? 0) + 1);
    }
  };

  for (let index = 0; index < macros.length; index++) {
    const macro = macros[index];
    // Entering a new passage: anything still open stays unmatched.
    let crossed = false;
    while (nextBoundary < boundaries.length && macro.range.start.line >= boundaries[nextBoundary]) {
      nextBoundary++;
      crossed = true;
    }
    if (crossed || index === 0) {
      if (crossed) stack = [];
      segmentEnd = index;
      while (
        segmentEnd < macros.length &&
        (nextBoundary >= boundaries.length || macros[segmentEnd].range.start.line < boundaries[nextBoundary])
      ) segmentEnd++;
      countClosers(index, segmentEnd);
    }

    if (!isBlock(macro.name)) continue;

    if (macro.open) {
      stack.push(macro);
      continue;
    }

    const name = macro.name.toLowerCase();
    pending.set(name, (pending.get(name) ?? 1) - 1);

    // The nearest open container of this name
    let target = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name.toLowerCase() === name) {
        target = i;
        break;
      }
    }
    if (target === -1) continue;

    // A container above it that is closed later: the containers cross
    let crossing = false;
    for (let i = target + 1; i < stack.length; i++) {
      if ((pending.get(stack[i].name.toLowerCase()) ?? 0) > 0) {
        crossing = true;
        break;
      }
    }
    if (crossing) {
      macro.expected = stack[stack.length - 1].name;
      continue;
    }

    const opener = stack[target];
    opener.pair = macro.id;
    macro.pair = opener.id;
    // Containers opened inside it but never closed remain unmatched
    stack.length = target;
  }
}

/**
 * The macros of a whole document as Spindle runs them: the bodies of passages
 * it does not tokenize as markup are masked first (see
 * maskNonMarkupPassages()), and, when `isBlock` is given, containers are
 * paired per passage by pairMacros(). Every consumer that reads macros from
 * a document, rather than from one passage's markup, goes through here.
 */
export function parseDocumentMacros(
  text: string,
  passages: Array<PassageRole & { range: Range }>,
  isBlock?: (name: string) => boolean,
): MacroNode[] {
  const macros = parseMacros(maskNonMarkupPassages(text, passages));
  if (isBlock) pairMacros(macros, isBlock, passages.map(p => p.range.start.line));
  return macros;
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
export interface MacroHeadPairing {
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
    ? parseDocumentMacros(text, pairing.passages, pairing.isBlock)
    : parseMacros(text);
  return macros
    // Spindle rejects a closer with no open container of its name in its
    // passage ("Unexpected closing"), so that is no call. A closer that
    // crosses another container (`{wrap}{if}{/wrap}{/if}`) is the closer of
    // an open container, written out of order: it stays with its widget.
    .filter((macro) => !pairing || macro.open || !pairing.isBlock(macro.name)
      || macro.pair !== -1 || macro.expected !== undefined)
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
