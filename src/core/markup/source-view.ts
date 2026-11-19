import type { PieceBase, TextPiece } from '@rohal12/spindle/tooling';
import type { PassageMarkup } from './passage-markup.js';
import { SourceOwnerIndex } from './source-owner-index.js';

const ownerIndexes = new WeakMap<PassageMarkup, SourceOwnerIndex>();

function owners(passage: PassageMarkup): SourceOwnerIndex {
  let index = ownerIndexes.get(passage);
  if (!index) {
    index = new SourceOwnerIndex(passage.pieces);
    ownerIndexes.set(passage, index);
  }
  return index;
}

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
  return owners(passage).find(start, end, 'text') as TextPiece | undefined;
}

/** Read a source span in the coordinate system that owns its decoded text. */
export function sourceView(passage: PassageMarkup, start: number, end: number): SourceView {
  const owner = owners(passage).find(start, end, 'source');
  if (owner?.kind === 'code') return { ...owner, text: owner.code };
  return owner?.kind === 'text' ? owner : { offset: 0, text: passage.content };
}
