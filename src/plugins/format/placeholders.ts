/**
 * Regex matching Spindle tokens in HTML:
 * - {/macroName} closing tags
 * - {macroName ...} opening tags (with optional CSS prefix, balanced nested braces)
 * - {$variable}, {_variable}, {@variable} (with optional dot paths)
 * - [[links]]
 */
const SPINDLE_TOKEN_REGEX = /(?:\{\/[A-Za-z][\w-]*\s*\}|\{(?:[#.][a-zA-Z][\w-]*\s*)*[A-Za-z][\w-]*(?:\s+(?:[^{}]|\{[^{}]*\})*)?\}|\{[$_@][a-zA-Z][\w.]*\}|\[\[(?:[^\]]*)\]\])/g;

/** Detect HTML tags in text (opening or self-closing or closing). */
const HTML_TAG_REGEX = /<\/?[a-zA-Z][\w-]*[\s>/]/;

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
 * Replace `<svg>…</svg>` blocks with HTML comment placeholders so Prettier
 * does not reformat them (CommonMark does not recognise multi-line SVG tags
 * as HTML blocks, so reformatted attributes break rendering).
 */
export function replaceSvgBlocks(html: string): PlaceholderResult {
  const tokens: string[] = [];
  const result = html.replace(/<svg[\s>][\s\S]*?<\/svg>/gi, (match) => {
    const idx = tokens.length;
    tokens.push(match);
    return `<!--SVG:${idx}-->`;
  });
  return { text: result, tokens };
}

/**
 * Restore SVG blocks from placeholders.
 */
export function restoreSvgBlocks(text: string, tokens: string[]): string {
  let result = text;
  for (let i = 0; i < tokens.length; i++) {
    result = result.replace(`<!--SVG:${i}-->`, tokens[i]);
  }
  return result;
}

/**
 * Replace Spindle tokens with placeholders.
 * Uses <!--SP:N--> in HTML content and __SPN__ in attribute values.
 *
 * Lines that contain Spindle tokens but no HTML tags are replaced as a
 * single whole-line placeholder so Prettier cannot split them.
 */
export function replaceSpindleTokens(html: string): PlaceholderResult {
  const tokens: string[] = [];
  const lines = html.split('\n');
  const resultLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Check if line has any Spindle tokens
    SPINDLE_TOKEN_REGEX.lastIndex = 0;
    if (!SPINDLE_TOKEN_REGEX.test(trimmed)) {
      resultLines.push(line);
      continue;
    }

    // Check if line has HTML tags after removing Spindle tokens
    SPINDLE_TOKEN_REGEX.lastIndex = 0;
    const withoutSpindle = trimmed.replace(SPINDLE_TOKEN_REGEX, '');
    const hasHtml = HTML_TAG_REGEX.test(withoutSpindle);

    if (!hasHtml) {
      // Line has Spindle tokens but no HTML — replace entire line with one placeholder
      const idx = tokens.length;
      tokens.push(trimmed);
      const indent = line.match(/^(\s*)/)?.[1] ?? '';
      resultLines.push(`${indent}<!--SP:${idx}-->`);
    } else {
      // Line has both HTML and Spindle — replace individual tokens
      SPINDLE_TOKEN_REGEX.lastIndex = 0;
      const replaced = line.replace(SPINDLE_TOKEN_REGEX, (match, ...args) => {
        const matchOffset = args[args.length - 2] as number;
        const idx = tokens.length;
        tokens.push(match);
        if (isInsideAttribute(line, matchOffset)) {
          return `__SP${idx}__`;
        }
        return `<!--SP:${idx}-->`;
      });
      resultLines.push(replaced);
    }
  }

  return { text: resultLines.join('\n'), tokens };
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
