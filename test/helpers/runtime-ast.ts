import { isBlockMacro, pairMarkup, tokenizeMarkupTolerant } from '@rohal12/spindle/tooling';

/** What the runtime's markup parser reports for a passage body: its first error, if any. */
export interface MarkupFailure {
  /** The `MarkupError` / `PairingError` code (`unclosed-tag`, `mismatched-closer`, ...). */
  code: string;
  message: string;
  /** Where the offending text starts. */
  at: number;
  /** The names the error involves (`name`, `closer`, ...). */
  data: Readonly<Record<string, string>>;
}

/**
 * What `parseMarkup` does with a passage body: tokenize, then pair, and throw
 * the first malformed tag or pairing error (the passage then shows "Error
 * parsing passage"). Both steps are the public tooling functions the runtime
 * calls (`tokenizeMarkupTolerant` / `pairMarkup`), so this is their first
 * error, not a reimplementation. `isBlock` is the story's block macros.
 */
export function runtimeMarkupFailure(passageBody: string, isBlock: (name: string) => boolean = isBlockMacro): MarkupFailure | null {
  const { tokens, errors } = tokenizeMarkupTolerant(passageBody);
  if (errors.length > 0) {
    const e = errors[0];
    return { code: e.code, message: e.reason, at: e.offset, data: e.data };
  }
  const paired = pairMarkup(tokens, { isBlock, source: passageBody }).errors;
  if (paired.length === 0) return null;
  const e = paired.reduce((first, next) => (next.noticedAt < first.noticedAt ? next : first));
  return { code: e.code, message: e.message, at: e.start, data: e.data };
}

/** Whether the installed Spindle's markup parser rejects a passage body, i.e. the passage shows "Error parsing passage". */
export function runtimeRejects(passageBody: string, isBlock?: (name: string) => boolean): boolean {
  return runtimeMarkupFailure(passageBody, isBlock) !== null;
}

/** The attribute values (`name=value`, non-empty) of the HTML tags the installed tokenizer reads. */
export function runtimeAttributeValues(passageBody: string): string[] {
  return tokenizeMarkupTolerant(passageBody).tokens.flatMap(token =>
    token.type === 'html' && !token.isClose ? Object.values(token.attributes).filter(value => value !== '') : []);
}
