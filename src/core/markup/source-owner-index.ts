import { pieceOffset, type CodePiece, type Piece, type TextPiece } from '@rohal12/spindle/tooling';

type Owner = CodePiece | TextPiece;
type OwnerKind = 'source' | 'text';
interface Node {
  left?: Node;
  right?: Node;
  source: number;
  text: number;
}

/**
 * Each start-prefix has a persistent tree of end offsets. A suffix maximum
 * returns the last containing piece, even for overlapping or unordered spans.
 * Building costs O(P log P) time/space; either ownership query costs O(log P).
 */
export class SourceOwnerIndex {
  private readonly ends: number[];
  private readonly versions: { start: number; root: Node }[];

  constructor(private readonly pieces: readonly Piece[]) {
    const entries = pieces.flatMap((piece, order) => {
      if (piece.kind !== 'text' && piece.kind !== 'code') return [];
      const value = piece.kind === 'text' ? piece.text : piece.code;
      return [{ start: piece.offset, end: pieceOffset(piece, value.length), order, text: piece.kind === 'text' }];
    });
    this.ends = [...new Set(entries.map(entry => entry.end))].sort((a, b) => a - b);
    const positions = new Map(this.ends.map((end, i) => [end, i]));
    let root: Node | undefined;
    this.versions = entries.sort((a, b) => a.start - b.start).map(entry => {
      root = this.insert(root, 0, this.ends.length - 1, positions.get(entry.end)!, entry.order, entry.text);
      return { start: entry.start, root };
    });
  }

  find(start: number, end: number, kind: OwnerKind): Owner | undefined {
    let low = 0;
    let high = this.versions.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.versions[mid].start <= start) low = mid + 1;
      else high = mid;
    }
    const root = this.versions[low - 1]?.root;
    return this.pieces[this.suffix(root, 0, this.ends.length - 1, end, kind)] as Owner | undefined;
  }

  private insert(node: Node | undefined, low: number, high: number, at: number, order: number, text: boolean): Node {
    if (low === high) return {
      source: Math.max(node?.source ?? -1, order),
      text: Math.max(node?.text ?? -1, text ? order : -1),
    };
    const mid = (low + high) >>> 1;
    const left = at <= mid ? this.insert(node?.left, low, mid, at, order, text) : node?.left;
    const right = at > mid ? this.insert(node?.right, mid + 1, high, at, order, text) : node?.right;
    return {
      left, right,
      source: Math.max(left?.source ?? -1, right?.source ?? -1),
      text: Math.max(left?.text ?? -1, right?.text ?? -1),
    };
  }

  private suffix(node: Node | undefined, low: number, high: number, end: number, kind: OwnerKind): number {
    if (!node || !(this.ends[high] >= end)) return -1;
    if (this.ends[low] >= end) return node[kind];
    const mid = (low + high) >>> 1;
    return Math.max(this.suffix(node.left, low, mid, end, kind), this.suffix(node.right, mid + 1, high, end, kind));
  }
}
