/**
 * What Spindle's `{link}` macro reads from its arguments, ported from
 * `components/macros/MacroLink.tsx` (`parseArgs`). A bracket link is rendered
 * as that macro: the tokenizer splits `[[display->target]]` and buildAST
 * builds the arguments from the two strings. The macro then reads them back
 * with a quote regex, so the two readings can differ:
 *
 *  - Spindle < 0.51.1 builds `"display" "target"` and reads it with
 *    `/(["'])(.*?)\1/g`: no escaping, and `.` does not match a line break. A
 *    `"` or a line break in the display or the target moves the passage the
 *    click navigates to (`[[He said "hi"->T]]` navigates nowhere,
 *    `[[{goto "X"}->Target]]` navigates to `}`, a two-line label navigates
 *    nowhere).
 *  - Spindle >= 0.51.1 escapes backslashes and double quotes when building
 *    the arguments and reads backslash escapes (and line breaks), so a
 *    bracket link always reads back unchanged. `{link}` written by hand now
 *    decodes `\"`, `\'` and `\\` (and only those).
 *
 * Verified against the installed runtime by `link-runtime.test.ts`.
 */
export interface LinkRead {
  display: string;
  /** The passage the click navigates to; null when it navigates nowhere. */
  passage: string | null;
}

/** The quoted strings of `{link}` arguments, as MacroLink collects them. */
export function linkMacroStrings(rawArgs: string, escapes: boolean): Array<{ text: string; start: number; end: number; quote: '"' | "'" }> {
  const re = escapes ? /(["'])((?:\\[^]|(?!\1)[^\\])*)\1/g : /(["'])(.*?)\1/g;
  const found: Array<{ text: string; start: number; end: number; quote: '"' | "'" }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawArgs)) !== null) {
    const raw = m[2];
    found.push({
      text: escapes ? raw.replace(/\\(["'\\])/g, '$1') : raw,
      start: m.index + 1,
      end: m.index + 1 + raw.length,
      quote: m[1] as '"' | "'",
    });
  }
  return found;
}

/** `parseArgs` of MacroLink. */
export function readLinkMacroArgs(rawArgs: string, escapes: boolean): LinkRead {
  const parts = linkMacroStrings(rawArgs, escapes).map(s => s.text);
  if (parts.length >= 2) return { display: parts[0], passage: parts[1] };
  if (parts.length === 1) return { display: parts[0], passage: null };
  return { display: rawArgs.trim(), passage: null };
}

/** buildAST's `quoteArg` (0.51.1): escape `\` and `"` so MacroLink reads the value back. */
function quoteArg(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/** What the link macro reads from the bracket link with this display and target. */
export function readBracketLink(display: string, target: string, escapes: boolean): LinkRead {
  const rawArgs = escapes ? `${quoteArg(display)} ${quoteArg(target)}` : `"${display}" "${target}"`;
  return readLinkMacroArgs(rawArgs, escapes);
}

/**
 * The runtime reading of a bracket link when it is not the link the source
 * says (display and target as the tokenizer splits them), else null.
 */
export function bracketLinkMismatch(display: string, target: string, escapes: boolean): LinkRead | null {
  const read = readBracketLink(display, target, escapes);
  return read.display === display && read.passage === target ? null : read;
}
