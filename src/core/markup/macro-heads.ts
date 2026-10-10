import { pairMarkup, type PairedMarkup, type Token } from '@rohal12/spindle/tooling';
import type { Position, Range } from '../types.js';
import type { DocumentMarkup, PassageMarkup } from './passage-markup.js';
import { walkNodes } from './tree.js';

/**
 * The name of a macro tag as written, `{name ...}` or `{/name}`.
 *
 * The heads are those of the paired tree, so a closer that closes nothing
 * (Spindle rejects it as "Unexpected closing") is none, and so are the tags
 * the tokenizer reads as text (a comment, an unclosed head). Macros in the
 * labels and attribute values that hold markup count: the runtime runs them.
 */
export interface MacroHead {
  name: string;
  closing: boolean;
  passage: PassageMarkup;
  /** The name's characters in `passage.content`: `[start, end)`. */
  start: number;
  end: number;
  /** The document range of the name. */
  range: Range;
}

interface Span {
  name: string;
  closing: boolean;
  start: number;
  end: number;
}

const kept = new WeakMap<PassageMarkup, readonly MacroHead[]>();

/**
 * The macro tags of a paired tree: the openers, the branches and the closers
 * of their macro. Pairing recovers around a closer that names an
 * element further out by leaving the elements inside it unclosed, so the
 * closer of such a macro, written out of order (`{outer}{inner}{/outer}{/inner}`),
 * is left stray: it is still the closer of the container it was written for.
 */
function* pairedHeads(paired: PairedMarkup, tokens: readonly Token[]): Generator<Span> {
  const unclosed: Array<{ name: string; start: number }> = [];
  for (const node of walkNodes(paired.nodes)) {
    if (node.token.type === 'macro') yield { name: node.token.name, closing: false, start: node.token.nameStart, end: node.token.nameEnd };
    for (const branch of node.body?.branches ?? []) {
      yield { name: branch.tag.name, closing: false, start: branch.tag.nameStart, end: branch.tag.nameEnd };
    }
    // A closer that names another element than the one it closes is rejected (mismatched): it is no call
    const close = node.body?.close;
    if (node.token.type !== 'macro') continue;
    if (close?.type === 'macro' && close.name.toLowerCase() === node.token.name.toLowerCase()) {
      yield { name: close.name, closing: true, start: close.nameStart, end: close.nameEnd };
    } else if (node.body && !close) {
      unclosed.push({ name: node.token.name.toLowerCase(), start: node.token.start });
    }
  }

  // A stray closer of a macro left unclosed before it (see above)
  const byStart = new Map(tokens.map((token) => [token.start, token]));
  for (const error of paired.errors) {
    const token = byStart.get(error.start);
    if (error.code !== 'stray-closer' || token?.type !== 'macro' || !token.isClose) continue;
    const name = token.name.toLowerCase();
    if (unclosed.some((open) => open.name === name && open.start < error.start)) {
      yield { name: token.name, closing: true, start: token.nameStart, end: token.nameEnd };
    }
  }
}

/** The macro heads of a passage, in source order. */
export function passageMacroHeads(passage: PassageMarkup): readonly MacroHead[] {
  let heads = kept.get(passage);
  if (heads) return heads;

  const isBlock = (name: string) => passage.doc.context.isBlock(name);
  const found = [...pairedHeads(passage.pairing, passage.tokens)];
  for (const piece of passage.pieces) {
    if (piece.kind !== 'text') continue;
    found.push(...pairedHeads(pairMarkup(piece.tokens, { isBlock }), piece.tokens));
  }
  heads = found
    .sort((a, b) => a.start - b.start)
    .map((head) => ({ ...head, passage, range: passage.range(head.start, head.end) }));
  kept.set(passage, heads);
  return heads;
}

/** The macro heads of a document. */
export function documentMacroHeads(doc: DocumentMarkup): MacroHead[] {
  return doc.passages.flatMap((passage) => passage.isMarkup ? [...passageMacroHeads(passage)] : []);
}

/** The macro head whose name contains `position` (the end of a name included). */
export function macroHeadAt(doc: DocumentMarkup, position: Position): MacroHead | undefined {
  const passage = doc.passageAt(position);
  if (!passage?.isMarkup) return undefined;
  return passageMacroHeads(passage).find(({ range: { start, end } }) =>
    start.line === position.line && position.character >= start.character && position.character <= end.character);
}
