/**
 * Argument boundaries of a widget invocation, as Spindle's runtime finds them.
 *
 * Mirrors `splitArgs` in Spindle's WidgetInvocation: the raw arguments are
 * split on top-level commas (outside quotes and (), [], {} nesting). Without
 * a top-level comma, a single expression is further split on top-level
 * whitespace when every resulting token is a standalone value, so
 * `{w "a" $b}` passes two arguments while `{w (1 + 2)}` and `{w $a + 1}`
 * pass one. Each argument is evaluated as its own expression.
 */

export interface WidgetArg {
  /** The argument's expression, trimmed as Spindle trims it. */
  text: string;
  /** Offset of the argument within the raw argument string. */
  start: number;
  end: number;
}

/** Split a widget invocation's raw arguments the way Spindle does. */
export function splitWidgetArguments(raw: string): WidgetArg[] {
  const args: WidgetArg[] = [];
  let depth = 0;
  let inString: string | null = null;
  let hasComma = false;
  let segmentStart = 0;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (inString) {
      if (ch === inString && raw[i - 1] !== '\\') inString = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      hasComma = true;
      args.push(trimmed(raw, segmentStart, i));
      segmentStart = i + 1;
    }
  }

  const last = trimmed(raw, segmentStart, raw.length);
  if (last.text) args.push(last);

  if (!hasComma && args.length === 1) {
    const split = splitOnWhitespace(raw, args[0]);
    if (split) return split;
  }

  return args;
}

/**
 * The index of the widget argument being typed when the invocation's
 * arguments so far are `argsBefore`. A standalone placeholder stands in for
 * the next character, so trailing whitespace or a comma starts a new
 * argument only where Spindle would split there.
 */
export function activeWidgetArgument(argsBefore: string): number {
  return splitWidgetArguments(argsBefore + '$').length - 1;
}

function trimmed(raw: string, start: number, end: number): WidgetArg {
  while (start < end && /\s/.test(raw[start])) start++;
  while (end > start && /\s/.test(raw[end - 1])) end--;
  return { text: raw.slice(start, end), start, end };
}

/**
 * Spindle's whitespace fallback: split on whitespace at depth 0, but only
 * when there are two or more tokens and each is a standalone value.
 */
function splitOnWhitespace(raw: string, arg: WidgetArg): WidgetArg[] | null {
  const tokens: WidgetArg[] = [];
  let depth = 0;
  let inString: string | null = null;
  let tokenStart = -1;

  for (let i = arg.start; i < arg.end; i++) {
    const ch = raw[i];

    if (inString) {
      if (ch === inString && raw[i - 1] !== '\\') inString = null;
      continue;
    }

    if (/\s/.test(ch) && depth === 0) {
      if (tokenStart !== -1) {
        tokens.push({ text: raw.slice(tokenStart, i), start: tokenStart, end: i });
        tokenStart = -1;
      }
      continue;
    }

    if (tokenStart === -1) tokenStart = i;
    if (ch === '"' || ch === "'" || ch === '`') inString = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
  }

  if (tokenStart !== -1) {
    tokens.push({ text: raw.slice(tokenStart, arg.end), start: tokenStart, end: arg.end });
  }

  if (tokens.length < 2) return null;
  if (!tokens.every(t => isStandaloneValue(t.text))) return null;
  return tokens;
}

/** Whether a whitespace-delimited token is a value rather than an operator. */
function isStandaloneValue(token: string): boolean {
  const first = token[0];
  if (first === '"' || first === "'" || first === '`') return true;
  if (first === '$' || first === '_' || first === '@' || first === '%') return true;
  if (/\d/.test(first)) return true;
  if ((first === '-' || first === '+') && token.length > 1 && /\d/.test(token[1])) return true;
  if (first === '(' || first === '[' || first === '{') return true;
  if (/^(true|false|null|undefined)$/.test(token)) return true;
  if (first === '!' && token.length > 1) return true;
  return false;
}
