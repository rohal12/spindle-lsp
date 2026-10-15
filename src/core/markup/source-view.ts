import { pieceOffset, type PieceBase, type TextPiece } from '@rohal12/spindle/tooling';
import type { PassageMarkup } from './passage-markup.js';

/** The decoded text and its public tooling map back to passage content. */
export interface SourceView extends PieceBase {
  text: string;
}

/** The decoded boundary at or immediately before a source offset. */
export function viewIndex(view: PieceBase, offset: number): number {
  if (!view.sourceOffsets) return offset - view.offset;
  let low = 0;
  let high = view.sourceOffsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (view.sourceOffsets[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The innermost label/attribute containing a source span. */
export function textAt(passage: PassageMarkup, start: number, end: number): TextPiece | undefined {
  return passage.pieces.filter((piece): piece is TextPiece =>
    piece.kind === 'text' && piece.offset <= start && pieceOffset(piece, piece.text.length) >= end).at(-1);
}

/** Read a source span in the coordinate system that owns its decoded text. */
export function sourceView(passage: PassageMarkup, start: number, end: number): SourceView {
  const owner = passage.pieces.filter(piece => {
    const value = piece.kind === 'text' ? piece.text : piece.kind === 'code' ? piece.code : undefined;
    return value !== undefined && piece.offset <= start && pieceOffset(piece, value.length) >= end;
  }).at(-1);
  if (owner?.kind === 'code') return { ...owner, text: owner.code };
  return owner?.kind === 'text' ? owner : { offset: 0, text: passage.content };
}
