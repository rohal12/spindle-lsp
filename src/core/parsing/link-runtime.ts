import { builtinMacros, passagePieces } from '@rohal12/spindle/tooling';

/**
 * What Spindle's `{link}` macro reads from its arguments. Every bracket link
 * is rendered as that macro: the AST turns `[[display->target]]` into
 * `{link "display" "target"}`, quoting both with `quoteArg`, and the macro
 * reads the arguments as it reads any macro's (`passagePieces` with the
 * built-in `link` declaration: `text` is a quoted string holding markup,
 * `passage` a quoted JavaScript string literal or an expression).
 *
 * A bracket link therefore reads back as written, except where the quoted
 * target is not a string literal: a raw line break in it makes the macro read
 * an expression, and a click on the link fails.
 */
export interface LinkRead {
  display: string;
  /** The passage the click navigates to; null when it navigates nowhere (no name, or an expression). */
  passage: string | null;
}

/** The AST's `quoteArg`: `value` as a quoted macro argument, `\` and `"` escaped. */
export function quoteArg(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/** What the link macro reads from `{link ...rawArgs}`. */
export function readLinkMacro(rawArgs: string): LinkRead {
  const pieces = passagePieces(`{link ${rawArgs}}`, builtinMacros).filter(piece => !piece.nested);
  const label = pieces.find(piece => piece.kind === 'text');
  const name = pieces.find(piece => piece.kind === 'passage');
  return {
    display: label?.kind === 'text' ? label.text : '',
    passage: name?.kind === 'passage' ? name.name : null,
  };
}

/** What the link macro reads from the bracket link with this display and target. */
export function readBracketLink(display: string, target: string): LinkRead {
  return readLinkMacro(`${quoteArg(display)} ${quoteArg(target)}`);
}

/**
 * The runtime reading of a bracket link when it is not the link the source
 * says (display and target as the tokenizer splits them), else null.
 * `escapes` is ignored: the minimum Spindle always escapes (callers still
 * passing it should stop).
 */
export function bracketLinkMismatch(display: string, target: string, escapes?: boolean): LinkRead | null {
  void escapes;
  const read = readBracketLink(display, target);
  return read.display === display && read.passage === target ? null : read;
}
