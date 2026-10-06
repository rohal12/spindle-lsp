import { buildAST } from '../../node_modules/@rohal12/spindle/src/markup/ast.js';
import { tokenize } from '../../node_modules/@rohal12/spindle/src/markup/tokenizer.js';

/**
 * Whether the installed Spindle's markup pipeline (tokenize, then buildAST)
 * throws on a passage body, i.e. the passage shows "Error parsing passage".
 */
export function runtimeRejects(passageBody: string): boolean {
  try {
    buildAST(tokenize(passageBody));
    return false;
  } catch {
    return true;
  }
}

/** The attribute values (`name=value`, non-empty) of the HTML tags the installed tokenizer reads. */
export function runtimeAttributeValues(passageBody: string): string[] {
  return tokenize(passageBody).flatMap(token =>
    token.type === 'html' && !token.isClose ? Object.values(token.attributes).filter(value => value !== '') : []);
}
