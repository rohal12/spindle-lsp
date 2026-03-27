import type { MacroNode, Range } from '../types.js';

/**
 * Regex for variable interpolation: {$var}, {_var}, {@var}
 * These must be neutralized before macro parsing to avoid false matches.
 */
const variableInterpolationRegex = /(?<!\\)\{([$_@%][A-Za-z_$][\w$.]*)\}/g;

/**
 * Spindle macro regex.
 * Groups:
 *   1 = closing slash (/) — present for closing macros
 *   2 = CSS prefix (e.g. ".red#alert ")
 *   3 = macro name
 *   4 = raw arguments
 */
const macroRegex = /(?<!\\)\{(\/)?(?:((?:[#.][a-zA-Z][\w-]*\s*)*)([A-Za-z][\w-]*))(?:\s+((?:(?:`(?:\\.|[^`\\])*?`)|(?:"(?:\\.|[^"\\])*?")|(?:'(?:\\.|[^'\\])*?')|(?:\[(?:[<>]?[Ii][Mm][Gg])?\[[^\r\n]*?\]\]+)|[^}]|(?:}))*?))?\}/gmi;

/**
 * Build an array of line-start offsets from text.
 * lineStarts[i] is the character offset where line i begins.
 */
function buildLineStarts(text: string): number[] {
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
function offsetToPosition(offset: number, lineStarts: number[]): { line: number; character: number } {
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
 */
export function parseMacros(text: string): MacroNode[] {
  // Replace variable interpolation with same-length spaces to preserve offsets
  const cleaned = text.replace(variableInterpolationRegex, (match) => {
    return ' '.repeat(match.length);
  });

  const lineStarts = buildLineStarts(text);
  const macros: MacroNode[] = [];
  let id = 0;

  // Reset regex state (global regex)
  macroRegex.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = macroRegex.exec(cleaned)) !== null) {
    const closeSlash = match[1];
    const cssPrefix = (match[2] || '').trim();
    const macroName = match[3];
    const rawArgs = match[4];

    const open = closeSlash !== '/';

    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;

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
 * Pair opening and closing macros using a name-keyed stack algorithm.
 *
 * For each opening macro where isBlock(name) returns true, push onto a
 * per-name stack. For each closing macro, pop the matching opening macro
 * and set both their pair fields to each other's id.
 *
 * Unmatched macros keep pair = -1.
 */
export function pairMacros(macros: MacroNode[], isBlock: (name: string) => boolean): void {
  const stacks: Record<string, number[]> = {};

  for (const macro of macros) {
    const name = macro.name.toLowerCase();

    if (!isBlock(macro.name)) continue;

    if (macro.open) {
      if (!stacks[name]) stacks[name] = [];
      stacks[name].push(macro.id);
    } else {
      // Closing macro — pop the matching opening macro
      const stack = stacks[name];
      if (stack && stack.length > 0) {
        const openId = stack.pop()!;
        macros[openId].pair = macro.id;
        macro.pair = openId;
      }
    }
  }
}
