import type { Position, Range } from './types.js';

/**
 * Build an array of line-start offsets from text.
 * lineStarts[i] is the character offset where line i begins.
 */
export function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** Convert a character offset to a line/character Position using precomputed line starts. */
export function offsetToPosition(offset: number, lineStarts: readonly number[]): Position {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low, character: offset - lineStarts[low] };
}

/** Convert a line/character Position to a character offset using precomputed line starts. */
export function positionToOffset(position: Position, lineStarts: readonly number[]): number {
  const start = lineStarts[position.line];
  return start === undefined ? (lineStarts[lineStarts.length - 1] ?? 0) : start + position.character;
}

/** The Range between two offsets of one text. */
export function offsetsToRange(start: number, end: number, lineStarts: readonly number[]): Range {
  return { start: offsetToPosition(start, lineStarts), end: offsetToPosition(end, lineStarts) };
}
