/**
 * Regex matching Spindle tokens in HTML:
 * - {/macroName} closing tags
 * - {macroName ...} opening tags (with optional CSS prefix)
 * - {$variable}, {_variable}, {@variable} (with optional dot paths)
 * - [[links]]
 */
const SPINDLE_TOKEN_REGEX = /(?:\{\/[A-Za-z][\w-]*\s*\}|\{(?:[#.][a-zA-Z][\w-]*\s*)*[A-Za-z][\w-]*(?:\s+(?:[^}]|\}(?=[^}]))*?)?\}|\{[$_@][a-zA-Z][\w.]*\}|\[\[(?:[^\]]*)\]\])/g;

/**
 * Check if a position in the string is inside an HTML attribute value.
 * Walks forward from start tracking quote context around = signs.
 */
function isInsideAttribute(text: string, pos: number): boolean {
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < pos; i++) {
    const ch = text[i];
    if (!inQuote && (ch === '"' || ch === "'") && i > 0 && text[i - 1] === '=') {
      inQuote = true;
      quoteChar = ch;
    } else if (inQuote && ch === quoteChar) {
      inQuote = false;
    }
  }
  return inQuote;
}

export interface PlaceholderResult {
  text: string;
  tokens: string[];
}

/**
 * Replace Spindle tokens with placeholders.
 * Uses <!--SP:N--> in HTML content and __SPN__ in attribute values.
 */
export function replaceSpindleTokens(html: string): PlaceholderResult {
  const tokens: string[] = [];
  const text = html.replace(SPINDLE_TOKEN_REGEX, (match, ...args) => {
    const offset = args[args.length - 2] as number;
    const idx = tokens.length;
    tokens.push(match);
    if (isInsideAttribute(html, offset)) {
      return `__SP${idx}__`;
    }
    return `<!--SP:${idx}-->`;
  });
  return { text, tokens };
}

/**
 * Restore original Spindle tokens from placeholders.
 */
export function restoreSpindleTokens(text: string, tokens: string[]): string {
  let result = text;
  for (let i = 0; i < tokens.length; i++) {
    result = result.replace(`<!--SP:${i}-->`, tokens[i]);
    result = result.replace(`__SP${i}__`, tokens[i]);
  }
  return result;
}
