/**
 * Writing a passage name as the body of a JavaScript string literal.
 *
 * `{goto}`, `{include}` and `{link}` read a quoted `passage` argument as a
 * JavaScript string literal (`passageTarget`), so a name is spelled with the
 * escapes that read it back. Reading a literal is the tooling API's
 * (`passageTarget`, `readQuoted`).
 */

/**
 * Spell `value` as the body of a string literal delimited by `quote`, so
 * that `passageTarget` reads `value` again.
 */
export function encodeStringLiteralBody(value: string, quote: '"' | "'"): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' || ch === quote) out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === ' ') out += '\\u2028';
    else if (ch === ' ') out += '\\u2029';
    else out += ch;
  }
  return out;
}
