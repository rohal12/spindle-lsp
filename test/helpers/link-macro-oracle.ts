import { builtinMacros, passagePieces } from '@rohal12/spindle/tooling';
import { tokenize } from './tooling.js';

export interface LinkRead {
  /** The label, as the macro reads it (before its markup is resolved); '' if its text argument is malformed. */
  display: string;
  /**
   * The passage a click navigates to when the `passage` argument is a quoted
   * name; null when there is none, or when it is an expression (`expression`
   * is then set: the name is only known when the macro runs).
   */
  passage: string | null;
  expression?: string;
}

/**
 * What the runtime's link macro reads from `{link ...rawArgs}`: the pieces of
 * the passage that `passagePieces` (the reader the story-start check and
 * `collectPassageReferences` use) finds in the macro, against the built-in
 * macros' declared parameters (`text`: a quoted string holding markup;
 * `passage`: a quoted name or an expression).
 */
export function runtimeLinkMacro(rawArgs: string): LinkRead {
  const pieces = passagePieces(`{link ${rawArgs}}`, builtinMacros).filter(piece => !piece.nested);
  const text = pieces.find(piece => piece.kind === 'text');
  const name = pieces.find(piece => piece.kind === 'passage');
  const expression = pieces.find(piece => piece.kind === 'code' && piece.passage);
  return {
    display: text?.kind === 'text' ? text.text : '',
    passage: name?.kind === 'passage' ? name.name : null,
    ...(expression?.kind === 'code' ? { expression: expression.code } : {}),
  };
}

/** `value` as a quoted macro argument: the rule that turns a bracket link into `{link "label" "target"}` (markup/ast.ts). */
export const quoteArg = (value: string) => `"${value.replace(/[\\"]/g, '\\$&')}"`;

/**
 * What the runtime's link macro reads for the single bracket link in `text`:
 * the tokenizer's link token, which the AST turns into `{link "label"
 * "target"}` (the label and target quoted), then the macro's own reading.
 */
export function runtimeBracketLink(text: string): (LinkRead & { token: { display: string; target: string } }) | null {
  const token = tokenize(text).find(t => t.type === 'link');
  if (!token || token.type !== 'link') return null;
  return { ...runtimeLinkMacro(`${quoteArg(token.display)} ${quoteArg(token.target)}`), token: { display: token.display, target: token.target } };
}
