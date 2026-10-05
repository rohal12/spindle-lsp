/**
 * Static decoding and encoding of JavaScript string-literal bodies.
 *
 * `{goto}` and `{include}` hand their arguments to Spindle's expression
 * evaluator, so a quoted target is a JavaScript string literal and its
 * passage identity is the literal's value. These helpers compute that value
 * (and write a value back) without evaluating any author code.
 */

export type JsQuote = '"' | "'" | '`';

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v',
};

/**
 * The value of a string literal's body (the text between the quotes), or
 * null when the literal is not statically decidable: a malformed escape,
 * a legacy octal escape, an unescaped line break in a quoted (non-template)
 * literal, or an unescaped delimiter. Spindle falls back to the raw text for
 * such arguments, which is not the passage identity this decoder reports.
 */
export function decodeStringLiteralBody(body: string, quote: JsQuote): string | null {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === quote) return null;
    if (ch === '\n' || ch === '\r') {
      if (quote !== '`') return null;
      out += ch;
      continue;
    }
    if (ch !== '\\') {
      out += ch;
      continue;
    }

    const next = body[++i];
    if (next === undefined) return null;
    if (next in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[next];
    } else if (next === '0') {
      if (/[0-9]/.test(body[i + 1] ?? '')) return null;
      out += '\0';
    } else if (/[1-9]/.test(next)) {
      return null;
    } else if (next === 'x') {
      const hex = body.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
    } else if (next === 'u') {
      if (body[i + 1] === '{') {
        const close = body.indexOf('}', i + 2);
        const hex = close === -1 ? '' : body.slice(i + 2, close);
        if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
        const code = parseInt(hex, 16);
        if (code > 0x10ffff) return null;
        out += String.fromCodePoint(code);
        i = close;
      } else {
        const hex = body.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      }
    } else if (next === '\r') {
      // Line continuation (CRLF counts as one terminator)
      if (body[i + 1] === '\n') i++;
    } else if (next === '\n' || next === ' ' || next === ' ') {
      // Line continuation: contributes nothing
    } else {
      // Identity escape: \\ \" \' \` and any other character
      out += next;
    }
  }
  return out;
}

/**
 * Spell `value` as the body of a string literal delimited by `quote`, so
 * that decodeStringLiteralBody() returns `value` again.
 */
export function encodeStringLiteralBody(value: string, quote: JsQuote): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' || ch === quote) out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === ' ') out += '\\u2028';
    else if (ch === ' ') out += '\\u2029';
    else if (quote === '`' && ch === '$' && value[i + 1] === '{') out += '\\$';
    else out += ch;
  }
  return out;
}
