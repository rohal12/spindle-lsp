import { lexJs, pieceOffset, type MacroToken, type Sigil, type Token } from '@rohal12/spindle/tooling';
import type { PassageMarkup } from '../core/markup/passage-markup.js';

/**
 * What a passage's markup names, read from the tooling API's tokens and
 * pieces: the macros called (hover, semantic tokens) and the variables
 * referenced or declared (hover, semantic tokens, completions). Offsets are
 * `content` offsets of the passage (see PassageMarkup).
 */

/** Every token of a passage's markup: the flat ones, and those inside the labels and attribute values that hold markup. */
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

/** A variable reference or declaration. */
export interface VariableUse {
  sigil: Sigil;
  /** The variable's name, without the sigil or any property path. */
  name: string;
  /** From the sigil to the end of the property path (`$player.name`). */
  start: number;
  end: number;
  /** A line of StoryVariables / StoryTransients declaring the variable. */
  declaration?: true;
}

/** The property path (`.a.b`) that follows a variable at `from` in `code`. */
const PROPERTY_PATH = /(?:\.[A-Za-z_$][\w$]*)*/y;

/**
 * The variables a passage runs or declares, in source order: `{$name}`
 * displays, the variables in code (conditions, `{set}`, `{do}` bodies,
 * expressions, in attribute values and labels too), and the declarations of
 * StoryVariables and StoryTransients. Text that merely looks like a variable
 * (prose, comments, the contents of strings) is none.
 */
export function variableUses(passage: PassageMarkup): VariableUse[] {
  const uses: VariableUse[] = [];
  if (!passage.isMarkup) {
    const sigil = passage.passage.name === 'StoryTransients' ? '%' : passage.passage.name === 'StoryVariables' ? '$' : undefined;
    if (!sigil) return uses;
    for (const declaration of passage.declarations.declarations) {
      uses.push({ sigil, name: declaration.name, start: declaration.nameStart - 1, end: declaration.nameEnd, declaration: true });
    }
    return uses;
  }

  for (const token of markupTokens(passage)) {
    if (token.type !== 'variable') continue;
    uses.push({
      sigil: passage.content[token.nameStart - 1] as Sigil,
      name: token.name.split('.')[0],
      start: token.nameStart - 1,
      end: token.nameEnd,
    });
  }

  for (const piece of passage.pieces) {
    if (piece.kind !== 'code') continue;
    lexJs(piece.code, {
      variable(sigil, name, index) {
        const nameEnd = index + 1 + name.length;
        const pathEnd = nameEnd + pathLength(piece.code, nameEnd);
        uses.push({ sigil, name, start: pieceOffset(piece, index), end: pieceOffset(piece, pathEnd - 1) + 1 });
      },
    }, piece.goal);
  }

  return uses.sort((a, b) => a.start - b.start);
}

function pathLength(code: string, from: number): number {
  PROPERTY_PATH.lastIndex = from;
  return PROPERTY_PATH.exec(code)![0].length;
}
