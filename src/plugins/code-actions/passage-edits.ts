import { passagePieces, type Piece } from '@rohal12/spindle/tooling';
import type { SpindleDiagnostic } from '../../core/diagnostic-codes.js';
import type { Range } from '../../core/types.js';
import type { DocumentMarkup, PassageMarkup } from '../../core/markup/passage-markup.js';
import { documentPassageRefs, encodeEnclosingMarkup, type PassageRef } from '../../core/markup/passage-refs.js';
import { positionToOffset } from '../../core/text.js';
import { encodeStringLiteralBody } from '../../core/parsing/js-string-literal.js';
import { encodePassageRefName } from '../rename.js';

type TextEdit = { range: Range; newText: string };
interface Located { offset: number; order: number }
interface ValidationState {
  pieces: Piece[];
  signatures: string[];
  targets: Located[];
}

function identity(piece: Piece): string {
  if (piece.kind === 'passage') return `passage ${piece.macro} ${piece.name}`;
  if (piece.kind === 'code') return `code ${piece.macro} ${piece.goal} ${piece.code}`;
  return piece.kind;
}

/** First entry in a source interval, retaining tooling's order for nested pieces. */
function inRange<T extends Located>(entries: T[], start: number, end: number, accepts: (entry: T) => boolean): T | undefined {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (entries[mid].offset < start) low = mid + 1;
    else high = mid;
  }
  let found: T | undefined;
  for (let i = low; i < entries.length && entries[i].offset < end; i++) {
    const entry = entries[i];
    if ((!found || entry.order < found.order) && accepts(entry)) found = entry;
  }
  return found;
}

/** Request-local lookup and runtime read-back state, shared by all spelling fixes. */
export class PassageNameEditor {
  private readonly refs = new Map<PassageMarkup, Array<Located & { ref: PassageRef }>>();
  private readonly states = new Map<PassageMarkup, ValidationState>();

  constructor(private readonly markup: DocumentMarkup | undefined, private remaining: number) {
    if (!markup) return;
    for (const [order, ref] of documentPassageRefs(markup).entries()) {
      const entries = this.refs.get(ref.passage) ?? [];
      entries.push({ offset: ref.start, order, ref });
      this.refs.set(ref.passage, entries);
    }
    for (const entries of this.refs.values()) entries.sort((a, b) => a.offset - b.offset || a.order - b.order);
  }

  /** Full-passage parsing stays with Spindle; excess batch work waits for selection. */
  edit(diag: SpindleDiagnostic, name: string): TextEdit | 'deferred' | undefined {
    const markup = this.markup;
    const passage = markup?.passageAt(diag.range.start);
    if (!markup || !passage) return;
    const start = passage.contentOffset(positionToOffset(diag.range.start, markup.lineStarts));
    const end = passage.contentOffset(positionToOffset(diag.range.end, markup.lineStarts));
    const ref = inRange(this.refs.get(passage) ?? [], start, end, entry => entry.ref.end <= end)?.ref;
    const from = ref?.start ?? start;
    const to = ref?.end ?? end;
    let state = this.states.get(passage);
    if (!state) {
      const pieces = passage.pieces.filter(piece => piece.kind !== 'text');
      state = {
        pieces, signatures: pieces.map(identity),
        targets: pieces.flatMap((piece, order) => piece.kind === 'passage' || piece.kind === 'code'
          ? [{ offset: piece.offset, order }] : []).sort((a, b) => a.offset - b.offset || a.order - b.order),
      };
      this.states.set(passage, state);
    }
    const changed = inRange(state.targets, start, end, () => true)?.order;
    if (changed === undefined) return;
    const target = state.pieces[changed];
    if (target.kind !== 'passage' && target.kind !== 'code') return;
    const expected = `passage ${target.macro} ${name}`;

    for (const quote of ['"', "'"] as const) {
      let newText: string;
      try {
        newText = ref ? encodePassageRefName(ref, name)
          : encodeEnclosingMarkup(passage, from, to, quote + encodeStringLiteralBody(name, quote) + quote);
      } catch { continue; }
      const size = passage.content.length - (to - from) + newText.length;
      if (size > this.remaining) return 'deferred';
      this.remaining -= size;
      const rewritten = passage.content.slice(0, from) + newText + passage.content.slice(to);
      const after = passagePieces(rewritten, markup.context.macros).filter(piece => piece.kind !== 'text');
      if (after.length === state.signatures.length
        && after.every((piece, index) => identity(piece) === (index === changed ? expected : state.signatures[index]))) {
        return { range: passage.range(from, to), newText };
      }
    }
  }
}
