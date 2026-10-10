import {
  builtinMacros,
  isBlockMacro,
  pairMarkup,
  passagePieces,
  tokenizeMarkupTolerant,
  type PairedMarkup,
  type Token,
} from '@rohal12/spindle/tooling';

export type { Token };
export { builtinMacros };

/**
 * The tokens the installed Spindle reads from markup, through its public
 * tooling API. Malformed tags do not throw: they are read as text, as the
 * runtime's own tokenizer used to for the inputs the tests probe.
 */
export function tokenize(source: string, options?: { text?: boolean }): Token[] {
  return tokenizeMarkupTolerant(source, options).tokens;
}

/** The runtime's CRLF normalization (the compiler reads passages with LF), with a map back to the original offsets. */
export function normalizeEol(text: string): { lf: string; toOriginal: (offset: number) => number } {
  const lf = text.replace(/\r\n/g, '\n');
  if (lf.length === text.length) return { lf, toOriginal: offset => offset };
  const toOriginal: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r' && text[i + 1] === '\n') continue;
    toOriginal.push(i);
  }
  toOriginal.push(text.length);
  return { lf, toOriginal: offset => toOriginal[offset] ?? text.length };
}

/**
 * Pair the tokens of `source` as the runtime builds its tree from them
 * (`pairMarkup`, the function `parseMarkup` itself calls). `isBlock` adds the
 * block macros the story defines (the default is the built-in ones).
 */
export function pair(source: string, isBlock: (name: string) => boolean = isBlockMacro): PairedMarkup {
  return pairMarkup(tokenize(source), { isBlock, source });
}

/**
 * Every token the runtime reads from a passage body, with offsets into
 * `source`: the passage's own tokens (`nested: false`) and the tokens of the
 * markup inside them (`nested: true`). Spindle 0.59 resolves the labels of
 * links and macros and the values of HTML attributes as markup of their own
 * (`{if}`, `{goto}`, `{$x}` there are real macros and variables), in text mode
 * where `[[` and `<` are text; `passagePieces` finds that markup and reports
 * its tokens with offsets into the passage, so each token is in exactly one
 * list.
 */
export function deepTokens(source: string): Array<{ token: Token; nested: boolean }> {
  const out = tokenize(source).map(token => ({ token, nested: false }));
  for (const piece of passagePieces(source, builtinMacros)) {
    if (piece.kind !== 'text') continue;
    for (const token of piece.tokens) out.push({ token, nested: true });
  }
  return out;
}
