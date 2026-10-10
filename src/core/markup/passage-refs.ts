import type { PassagePiece, TextPiece } from '@rohal12/spindle/tooling';
import type { Position, Range } from '../types.js';
import type { DocumentMarkup, PassageMarkup } from './passage-markup.js';

/**
 * How a passage name is written, which decides how a new name is spelled:
 *  - `bracket`: the target of a `[[link]]`
 *  - `quoted`: a string literal argument (`{goto "Hall"}`, `{link "Go" "Hall"}`,
 *    the `goto` of `{watch}`), read as JavaScript
 *  - `text`: markup text read as the name (the body of `{dialog}`)
 */
export type PassageRefForm = 'bracket' | 'quoted' | 'text';

/**
 * A passage name written out in the markup, as `passagePieces` reports it. A
 * bare word or a template literal is an expression (it names a passage only
 * when it runs), so it is no reference.
 */
export interface PassageRef {
  /** The passage it names (a quoted string's value). */
  name: string;
  /** The characters of the name as written, in the document (inside the quotes of a quoted name). */
  range: Range;
  form: PassageRefForm;
  /** The delimiter of a quoted name. */
  quote?: '"' | "'";
  /** The macro it is the argument of; `link` for a `[[link]]`. */
  macro: string;
  /** The passage that holds it. */
  passage: PassageMarkup;
  /** Where the characters of the name are in `passage.content`: `[start, end)`. */
  start: number;
  end: number;
  /** Its index in `passage.pieces`. */
  piece: number;
  /**
   * Set when the reference is markup inside a label or an attribute value:
   * the quote that delimits the text it is in (a quoted macro argument is
   * unescaped once more before its markup is read), and whether that text is
   * an HTML attribute value.
   */
  within?: { quote?: '"' | "'"; attribute: boolean };
}

const kept = new WeakMap<PassageMarkup, readonly PassageRef[]>();
const byName = new WeakMap<DocumentMarkup, Map<string, PassageRef[]>>();

/** The passage names written out in a passage, in source order, labels and attribute values included. */
export function passageRefs(passage: PassageMarkup): readonly PassageRef[] {
  let refs = kept.get(passage);
  if (!refs) {
    refs = readRefs(passage);
    kept.set(passage, refs);
  }
  return refs;
}

/** The passage names written out in a document. */
export function documentPassageRefs(doc: DocumentMarkup): PassageRef[] {
  return doc.passages.flatMap((passage) => [...passageRefs(passage)]);
}

/** The references to passage `name` in a document. */
export function documentRefsNamed(doc: DocumentMarkup, name: string): readonly PassageRef[] {
  let index = byName.get(doc);
  if (!index) {
    index = new Map();
    for (const ref of documentPassageRefs(doc)) {
      const list = index.get(ref.name);
      if (list) list.push(ref);
      else index.set(ref.name, [ref]);
    }
    byName.set(doc, index);
  }
  return index.get(name) ?? [];
}

/** The reference whose characters contain `position` (the end of a name included). */
export function passageRefAt(doc: DocumentMarkup, position: Position): PassageRef | undefined {
  const passage = doc.passageAt(position);
  if (!passage) return undefined;
  return passageRefs(passage).find(({ range: { start, end } }) =>
    (position.line > start.line || (position.line === start.line && position.character >= start.character)) &&
    (position.line < end.line || (position.line === end.line && position.character <= end.character)));
}

function readRefs(passage: PassageMarkup): PassageRef[] {
  const refs: PassageRef[] = [];
  const content = passage.content;
  // The texts (labels, attribute values) whose markup the next pieces are
  const open: Array<{ text: TextPiece; end: number }> = [];

  passage.pieces.forEach((piece, index) => {
    if (!piece.nested) open.length = 0;
    else while (open.length > 0 && piece.offset >= open[open.length - 1].end) open.pop();
    if (piece.kind === 'text') {
      open.push({ text: piece, end: textEnd(piece) });
      return;
    }
    if (piece.kind !== 'passage' || piece.name === '') return;

    const parent = open.at(-1)?.text;
    const span = nameSpan(piece, parent, content);
    if (!span) return;
    refs.push({
      name: piece.name,
      range: passage.range(span.start, span.end),
      form: span.form,
      quote: span.quote,
      macro: piece.macro,
      passage,
      start: span.start,
      end: span.end,
      piece: index,
      within: parent && {
        quote: quoteAt(content, parent.offset - 1),
        attribute: /\battribute of </.test(parent.where),
      },
    });
  });
  return refs;
}

/** Where a text piece ends in the source. */
function textEnd(text: TextPiece): number {
  return text.sourceOffsets ? text.sourceOffsets[text.sourceOffsets.length - 1] : text.offset + text.text.length;
}

function quoteAt(source: string, index: number): '"' | "'" | undefined {
  const ch = source[index];
  return ch === '"' || ch === "'" ? ch : undefined;
}

/**
 * Where the characters of the name of `piece` are, and how it is written.
 * A piece reports the markup it is in (`length` includes the quotes of a
 * quoted name). In a quoted macro argument with escapes the text is not
 * where its length says: the offsets of its characters come from `parent`.
 */
function nameSpan(
  piece: PassagePiece,
  parent: TextPiece | undefined,
  content: string,
): NameSpan | undefined {
  const offsets = parent?.sourceOffsets;
  if (offsets) {
    // The piece starts at the source offset of character `i` of the text and ends at that of `j`
    const i = offsets.indexOf(piece.offset);
    const j = offsets.indexOf(piece.offset + piece.length);
    if (i < 0 || j < 0) return undefined;
    return classify(piece, parent!.text[i], [offsets[i], offsets[j]], [offsets[i + 1], offsets[j - 1]]);
  }
  const end = piece.offset + piece.length;
  return classify(piece, content[piece.offset], [piece.offset, end], [piece.offset + 1, end - 1]);
}

interface NameSpan {
  start: number;
  end: number;
  form: PassageRefForm;
  quote?: '"' | "'";
}

/** `whole` is the markup of the name as written, `inner` what is inside its quotes. */
function classify(piece: PassagePiece, first: string | undefined, whole: [number, number], inner: [number, number]): NameSpan {
  if (isBracket(piece)) return { start: whole[0], end: whole[1], form: 'bracket' };
  // The body of {dialog} is text; a name that is not in quotes is text too
  if (piece.macro === 'dialog' || (first !== '"' && first !== "'")) return { start: whole[0], end: whole[1], form: 'text' };
  return { start: inner[0], end: inner[1], form: 'quoted', quote: first };
}

function isBracket(piece: PassagePiece): boolean {
  return piece.macro === 'link' && piece.label.startsWith('[[');
}
