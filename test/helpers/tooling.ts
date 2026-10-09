import { tokenizeMarkupTolerant, type Token } from '@rohal12/spindle/tooling';

export type { Token };

/**
 * The tokens the installed Spindle reads from markup, through its public
 * tooling API. Malformed tags do not throw: they are read as text, as the
 * runtime's own tokenizer used to for the inputs the tests probe.
 */
export function tokenize(source: string, options?: { text?: boolean }): Token[] {
  return tokenizeMarkupTolerant(source, options).tokens;
}
