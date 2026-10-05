import type { MacroNode, Range } from '../types.js';
import { createCodeScanner } from './code-scanner.js';
import { attributeValueSpans } from './html-scanner.js';
import { bracketLinkEnd } from './link-parser.js';

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
  // Replace variable interpolation with same-length spaces to preserve offsets
  const cleaned = text.replace(variableInterpolationRegex, (match) => {
    return ' '.repeat(match.length);
  });

  const lineStarts = buildLineStarts(text);
  const scanner = createCodeScanner(cleaned);
  const macros: MacroNode[] = [];
  let id = 0;

  const attributeValues = attributeValueSpans(text);
  let value = 0;
  const inAttributeValue = (offset: number): boolean => {
    while (value < attributeValues.length && attributeValues[value][1] <= offset) value++;
    return value < attributeValues.length && attributeValues[value][0] <= offset;
  };

  // Reset regex state (global regex)
  macroHeadRegex.lastIndex = 0;
  let match: RegExpExecArray | null;

  // Spindle tokenizes a complete bracket link as one token, so a macro head
  // inside it is label text. Whichever of `[[` and a macro head comes first
  // wins; an unclosed link is text.
  let linkStart = text.indexOf('[[');

  while ((match = macroHeadRegex.exec(text)) !== null) {
    const matchStart = match.index;
    let insideLink = false;
    while (linkStart !== -1 && linkStart < matchStart) {
      const end = bracketLinkEnd(text, linkStart);
      if (end === -1) {
        linkStart = text.indexOf('[[', linkStart + 2);
      } else if (end > matchStart) {
        macroHeadRegex.lastIndex = end;
        linkStart = text.indexOf('[[', end);
        insideLink = true;
        break;
      } else {
        linkStart = text.indexOf('[[', end);
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
    if (linkStart !== -1 && linkStart < matchEnd) linkStart = text.indexOf('[[', matchEnd);

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

/** A macro head's name as written in source, with the span of just the name. */
export interface MacroHeadName {
  name: string;
  closing: boolean;
  range: Range;
}

/**
 * The macro-head names of a document, delimited by the shared macro grammar
 * (selector prefixes, hyphenated names, `{/name}` closers, attribute values
 * and unclosed heads excluded). Widget navigation and rename use this so
 * their notion of a call matches what Spindle's tokenizer executes.
 */
export function macroHeadNames(text: string): MacroHeadName[] {
  return parseMacros(text).map((macro) => {
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
export function macroHeadNameAt(text: string, position: { line: number; character: number }): MacroHeadName | null {
  for (const head of macroHeadNames(text)) {
    const { start, end } = head.range;
    if (start.line === position.line && position.character >= start.character && position.character <= end.character) {
      return head;
    }
  }
  return null;
}
