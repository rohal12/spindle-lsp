import type { MacroToken, Token } from '@rohal12/spindle/tooling';
import type { PassageMarkup } from './passage-markup.js';

/**
 * Every token of a passage's markup: the flat ones, and those inside the
 * labels and attribute values that hold markup (the `text` pieces of
 * `passagePieces`). Offsets are `content` offsets of the passage.
 */
export function* markupTokens(passage: PassageMarkup): Generator<Token> {
  yield* passage.tokens;
  for (const piece of passage.pieces) {
    if (piece.kind === 'text') yield* piece.tokens;
  }
}

/** Every macro tag of a passage, closers included; the macro's name is `nameStart`..`nameEnd`. */
export function* macroTokens(passage: PassageMarkup): Generator<MacroToken> {
  for (const token of markupTokens(passage)) {
    if (token.type === 'macro') yield token;
  }
}
