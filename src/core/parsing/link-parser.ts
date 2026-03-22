import type { Range } from '../types.js';

export interface PassageRef {
  name: string;
  range: Range;
  source: 'link' | 'macro';
}

/**
 * Regex for [[display|target]] and [[target]] link syntax.
 * Group 1: optional display text followed by pipe
 * Group 2: passage name (target)
 */
const linkRegex = /\[\[([^\]]*?\|)?([^\]]+?)\]\]/g;

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
 * Parse all passage references from bracket links in the given text.
 *
 * Supports:
 *   [[PassageName]]
 *   [[Display Text|Target]]
 *
 * @param text - the text to parse
 * @param lineOffset - optional line offset added to all line numbers (default 0)
 */
export function parseLinks(text: string, lineOffset: number = 0): PassageRef[] {
  const lineStarts = buildLineStarts(text);
  const refs: PassageRef[] = [];

  linkRegex.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(text)) !== null) {
    const passageName = match[2].trim();
    if (!passageName) continue;

    // Calculate position of the passage name within the match
    const nameStartInMatch = match[0].indexOf(passageName);
    const nameStart = match.index + nameStartInMatch;
    const nameEnd = nameStart + passageName.length;

    const startPos = offsetToPosition(nameStart, lineStarts);
    const endPos = offsetToPosition(nameEnd, lineStarts);

    const range: Range = {
      start: { line: startPos.line + lineOffset, character: startPos.character },
      end: { line: endPos.line + lineOffset, character: endPos.character },
    };

    refs.push({
      name: passageName,
      range,
      source: 'link',
    });
  }

  return refs;
}
