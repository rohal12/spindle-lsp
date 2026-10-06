/**
 * The `$variable` references a passage executes, as Spindle >= 0.50.1 checks
 * them when the story starts (`validatePassages`): tokenizer-based, so prose,
 * plain strings and comments are not references. Mirrors that release's
 * markup tokenizer and `collectPassageRefs` (identical through 0.51.x), with
 * source offsets added; `test/unit/executable-refs.test.ts` compares it with
 * the installed runtime. Older Spindle scans the raw text instead (see
 * `validatedReferences` in variable-tracker.ts).
 */

/** A `$var.path` reference; `offset` is the index of its `$` in the content. */
export interface ExecutableRef {
  /** The dotted path after the `$`. */
  ref: string;
  offset: number;
}

type OnRef = (ref: string, offset: number) => void;

const VAR_REF_RE = /\$(\w+(?:\.\w+)*)/g;
/** `{` followed by a sigil starts an interpolation block inside literal text. */
const INTERP_START_RE = /^[$_@%]\w/;
/** Quoted first argument of an input macro naming a story variable. */
const QUOTED_VAR_ARG_RE = /^["']\$(\w+(?:\.\w+)*)["']?$/;

// ---------------------------------------------------------------------------
// JavaScript scanning (Spindle's scanCode and helpers)
// ---------------------------------------------------------------------------

/** Report every `$var.path` in a code segment free of strings/comments. */
function scanRefs(segment: string, base: number, onRef: OnRef): void {
  for (const match of segment.matchAll(VAR_REF_RE)) onRef(match[1], base + match.index);
}

/** Index of the quote closing the string opened at `start` (or the end). */
function findClosingQuote(code: string, start: number): number {
  const quote = code[start];
  let i = start + 1;
  while (i < code.length && code[i] !== quote) {
    i += code[i] === '\\' ? 2 : 1;
  }
  return Math.min(i, code.length);
}

/**
 * Scan literal text (string contents, HTML attribute values) for `{$…}`
 * interpolation blocks. A bare `$word` in literal text is not a reference.
 */
function scanInterpolations(text: string, base: number, onRef: OnRef): void {
  let i = text.indexOf('{');
  while (i !== -1) {
    const next = INTERP_START_RE.test(text.slice(i + 1, i + 3))
      ? scanCode(text, i + 1, base, onRef, true)
      : i + 1;
    i = text.indexOf('{', next);
  }
}

/**
 * Scan a template literal starting just after its opening backtick: literal
 * parts are text, `${…}` parts are code. Returns the index just past the
 * closing backtick.
 */
function scanTemplate(code: string, start: number, base: number, onRef: OnRef): number {
  let i = start;
  let textStart = start;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\') {
      i += 2;
    } else if (ch === '`') {
      scanInterpolations(code.slice(textStart, i), base + textStart, onRef);
      return i + 1;
    } else if (ch === '$' && code[i + 1] === '{') {
      scanInterpolations(code.slice(textStart, i), base + textStart, onRef);
      i = textStart = scanCode(code, i + 2, base, onRef, true);
    } else {
      i++;
    }
  }
  scanInterpolations(code.slice(textStart), base + textStart, onRef);
  return code.length;
}

/**
 * Report `$var` references in JavaScript code: sigils inside string literals
 * and comments are left alone, template-literal `${…}` parts are code. When
 * `nested`, stops at the `}` closing the enclosing block and returns the
 * index just past it. `base` is the offset of `code[0]` in the passage.
 */
function scanCode(code: string, start: number, base: number, onRef: OnRef, nested = false): number {
  let i = start;
  let segStart = start;
  let depth = 0;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    const isComment = ch === '/' && (next === '/' || next === '*');
    if (ch === '"' || ch === "'" || ch === '`' || isComment) {
      scanRefs(code.slice(segStart, i), base + segStart, onRef);
      if (ch === '`') {
        i = scanTemplate(code, i + 1, base, onRef);
      } else if (isComment) {
        const close = code.indexOf(next === '/' ? '\n' : '*/', i + 2);
        i = close === -1 ? code.length : next === '/' ? close : close + 2;
      } else {
        const close = findClosingQuote(code, i);
        scanInterpolations(code.slice(i + 1, close), base + i + 1, onRef);
        i = Math.min(close + 1, code.length);
      }
      segStart = i;
      continue;
    }
    if (nested && ch === '{') {
      depth++;
    } else if (nested && ch === '}' && depth-- === 0) {
      scanRefs(code.slice(segStart, i), base + segStart, onRef);
      return i + 1;
    }
    i++;
  }
  scanRefs(code.slice(segStart), base + segStart, onRef);
  return code.length;
}

// ---------------------------------------------------------------------------
// Markup tokenizer (Spindle's tokenize, reduced to what references need)
// ---------------------------------------------------------------------------

interface VariableToken {
  type: 'variable';
  /** Only `$` variables (`scope === 'variable'`) are story variables. */
  isStoryVariable: boolean;
  name: string;
  /** Offset of the first character of `name`. */
  nameStart: number;
}

interface ExpressionToken {
  type: 'expression';
  expression: string;
  exprStart: number;
}

interface MacroToken {
  type: 'macro';
  name: string;
  rawArgs: string;
  rawArgsStart: number;
  isClose: boolean;
  start: number;
  end: number;
}

interface HtmlToken {
  type: 'html';
  /** Attribute values by name: a repeated name keeps the last value. */
  values: Array<{ value: string; offset: number }>;
}

type Token = VariableToken | ExpressionToken | MacroToken | HtmlToken;

const VALID_TAG_START = /[a-zA-Z]/;
const RAW_BODY_MACROS = new Set(['do']);
const NON_STRING_QUOTE_PREFIX = /[\p{L}\p{N}_\\]/u;

/** `.foo.bar#baz` after `{` or `[[`; returns the index after the last segment. */
function skipSelectors(input: string, startIdx: number): number {
  let i = startIdx;
  while (i < input.length && (input[i] === '.' || input[i] === '#')) {
    i++;
    let name = '';
    while (i < input.length) {
      if (/[a-zA-Z0-9_-]/.test(input[i])) {
        name += input[i];
        i++;
      } else if (input[i] === '{' && (input[i + 1] === '$' || input[i + 1] === '_' || input[i + 1] === '@')) {
        const braceStart = i;
        i += 2;
        while (i < input.length && /[\w.]/.test(input[i])) i++;
        if (i < input.length && input[i] === '}') {
          i++;
          name += input.slice(braceStart, i);
        } else {
          i = braceStart;
          break;
        }
      } else {
        break;
      }
    }
  }
  return i;
}

function skipQuoted(input: string, i: number): number {
  const quote = input[i];
  let j = i + 1;
  while (j < input.length) {
    const c = input[j];
    if (c === '\\') j += 2;
    else if (c === quote) return j + 1;
    else if (c === '\n') return -1;
    else j++;
  }
  return -1;
}

function skipTemplate(input: string, i: number): number {
  let j = i + 1;
  while (j < input.length) {
    const c = input[j];
    if (c === '\\') {
      j += 2;
    } else if (c === '`') {
      return j + 1;
    } else if (c === '$' && input[j + 1] === '{') {
      const closeIdx = scanBalancedBrace(input, j + 2);
      if (closeIdx === -1) return -1;
      j = closeIdx + 1;
    } else {
      j++;
    }
  }
  return -1;
}

/** Index of the `}` balancing the `{` just before `i`, or -1. */
function scanBalancedBrace(input: string, i: number): number {
  let depth = 1;
  while (i < input.length) {
    const c = input[i];
    if (c === '{') {
      depth++;
    } else if (c === '}') {
      if (--depth === 0) return i;
    } else if ((c === '"' || c === "'") && !(i > 0 && NON_STRING_QUOTE_PREFIX.test(input[i - 1]))) {
      const end = skipQuoted(input, i);
      if (end !== -1) {
        i = end;
        continue;
      }
    } else if (c === '`') {
      const end = skipTemplate(input, i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    i++;
  }
  return -1;
}

/** Name, arguments and closer flag of macro content, with the arguments' offset. */
function parseMacroContent(content: string, contentStart: number): {
  name: string;
  rawArgs: string;
  rawArgsStart: number;
  isClose: boolean;
} {
  const lead = content.length - content.trimStart().length;
  const trimmed = content.trim();
  const isClose = trimmed.startsWith('/');
  const rest = isClose ? trimmed.slice(1) : trimmed;
  const restStart = contentStart + lead + (isClose ? 1 : 0);

  const spaceIdx = rest.search(/\s/);
  if (spaceIdx === -1) return { name: rest, rawArgs: '', rawArgsStart: restStart + rest.length, isClose };

  const afterName = rest.slice(spaceIdx + 1);
  return {
    name: rest.slice(0, spaceIdx),
    rawArgs: afterName.trim(),
    rawArgsStart: restStart + spaceIdx + 1 + (afterName.length - afterName.trimStart().length),
    isClose,
  };
}

function parseHtmlAttributes(
  input: string,
  start: number,
): { values: Map<string, { value: string; offset: number }>; endIdx: number } {
  const values = new Map<string, { value: string; offset: number }>();
  let j = start;
  while (j < input.length) {
    while (j < input.length && /\s/.test(input[j])) j++;
    if (j >= input.length || input[j] === '>' || (input[j] === '/' && input[j + 1] === '>')) break;

    const attrStart = j;
    while (j < input.length && /[a-zA-Z0-9_\-:@]/.test(input[j])) j++;
    const attrName = input.slice(attrStart, j);
    if (!attrName) break;

    if (input[j] === '=') {
      j++;
      if (input[j] === '"' || input[j] === "'") {
        const quote = input[j];
        j++;
        const valStart = j;
        while (j < input.length) {
          if (input[j] === '{') {
            const closeIdx = scanBalancedBrace(input, j + 1);
            if (closeIdx !== -1) {
              j = closeIdx + 1;
              continue;
            }
          } else if (input[j] === quote) break;
          j++;
        }
        values.set(attrName, { value: input.slice(valStart, j), offset: valStart });
        if (j < input.length) j++;
      } else {
        const valStart = j;
        while (j < input.length && /[^\s>]/.test(input[j])) j++;
        values.set(attrName, { value: input.slice(valStart, j), offset: valStart });
      }
    } else {
      values.set(attrName, { value: '', offset: j });
    }
  }
  return { values, endIdx: j };
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  /** After an opening `{do}`, jump to the first `{/do}`; the body is code, not markup. */
  function consumeRawBody(name: string, isClose: boolean): void {
    const lower = name.toLowerCase();
    if (isClose || !RAW_BODY_MACROS.has(lower)) return;
    const closeRe = new RegExp(`\\{/${lower}\\s*\\}`, 'gi');
    closeRe.lastIndex = i;
    const m = closeRe.exec(input);
    if (!m) return;
    const closeStart = m.index;
    const closeEnd = closeStart + m[0].length;
    tokens.push({
      type: 'macro',
      ...parseMacroContent(input.slice(closeStart + 1, closeEnd - 1), closeStart + 1),
      start: closeStart,
      end: closeEnd,
    });
    i = closeEnd;
  }

  /**
   * `{<sigil>name}` or `{<sigil>expression}` where the sigil is at `sigilIdx`;
   * `exprStart` is where an expression's text begins. Returns false if the
   * braces are unbalanced (the `{` is then plain text).
   */
  function sigilBlock(sigil: string, sigilIdx: number, exprStart: number): boolean {
    i = sigilIdx + 1;
    const nameStart = i;
    while (i < input.length && /[\w.]/.test(input[i])) i++;
    const name = input.slice(nameStart, i);
    if (input[i] === '}') {
      i++;
      tokens.push({ type: 'variable', isStoryVariable: sigil === '$', name, nameStart });
      return true;
    }
    const closeIdx = scanBalancedBrace(input, nameStart);
    if (closeIdx === -1) return false;
    tokens.push({ type: 'expression', expression: input.slice(exprStart, closeIdx), exprStart });
    i = closeIdx + 1;
    return true;
  }

  function macroBlock(contentStart: number, start: number): boolean {
    const closeIdx = scanBalancedBrace(input, contentStart);
    if (closeIdx === -1) return false;
    const content = input.slice(contentStart, closeIdx);
    i = closeIdx + 1;
    const parsed = parseMacroContent(content, contentStart);
    tokens.push({ type: 'macro', ...parsed, start, end: i });
    consumeRawBody(parsed.name, parsed.isClose);
    return true;
  }

  while (i < input.length) {
    if (input[i] === '\\' && (input[i + 1] === '{' || input[i + 1] === '}')) {
      i += 2;
      continue;
    }

    if (input[i] === '[' && input[i + 1] === '[') {
      const start = i;
      i += 2;
      if (input[i] === '.' || input[i] === '#') {
        i = skipSelectors(input, i);
        if (input[i] === ' ') i++;
      }
      let depth = 1;
      while (i < input.length && depth > 0) {
        if (input[i] === '[' && input[i + 1] === '[') {
          depth++;
          i += 2;
        } else if (input[i] === ']' && input[i + 1] === ']') {
          depth--;
          if (depth === 0) break;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth !== 0) {
        i = start + 2;
        continue;
      }
      i += 2;
      continue;
    }

    if (input[i] === '{') {
      const start = i;
      const nextChar = input[i + 1];

      if (nextChar === '.' || nextChar === '#') {
        const parsedEnd = skipSelectors(input, i + 1);
        const afterSelectors = input[parsedEnd] === ' ' ? parsedEnd + 1 : parsedEnd;
        const charAfter = input[afterSelectors];
        const handled =
          charAfter === '$' || charAfter === '_' || charAfter === '@' || charAfter === '%'
            ? sigilBlock(charAfter, afterSelectors, afterSelectors)
            : charAfter !== undefined && /[a-zA-Z]/.test(charAfter)
              ? macroBlock(afterSelectors, start)
              : false;
        if (!handled) i = start + 1;
        continue;
      }

      if (nextChar === '$' || nextChar === '_' || nextChar === '@' || nextChar === '%') {
        if (!sigilBlock(nextChar, i + 1, start + 1)) i = start + 1;
        continue;
      }

      if (nextChar !== undefined && (nextChar === '/' || /[a-zA-Z]/.test(nextChar))) {
        if (!macroBlock(i + 1, start)) i = start + 1;
        continue;
      }

      i++;
      continue;
    }

    if (input[i] === '<') {
      let j = i + 1;
      const isClose = input[j] === '/';
      if (isClose) j++;

      const tagStart = j;
      while (j < input.length && /[a-zA-Z0-9-]/.test(input[j])) j++;
      const tag = input.slice(tagStart, j);

      if (tag && VALID_TAG_START.test(tag[0])) {
        if (isClose) {
          while (j < input.length && /\s/.test(input[j])) j++;
          if (input[j] === '>') {
            i = j + 1;
            continue;
          }
        } else {
          const parsed = parseHtmlAttributes(input, j);
          j = parsed.endIdx;
          if (input[j] === '/') j++;
          if (input[j] === '>') {
            tokens.push({ type: 'html', values: [...parsed.values.values()] });
            i = j + 1;
            continue;
          }
        }
      }
      i++;
      continue;
    }

    i++;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Passage references (Spindle's collectPassageRefs)
// ---------------------------------------------------------------------------

/**
 * The `$var.path` references a passage evaluates: `{$var}` displays,
 * `{$expr}` expressions, macro arguments and `{do}` bodies (as code), quoted
 * variable names bound by input macros (`storeVarMacros`, lowercase), and
 * `{$…}` interpolations in HTML attributes. Prose is literal text.
 */
export function collectExecutableRefs(
  content: string,
  storeVarMacros: ReadonlySet<string>,
): ExecutableRef[] {
  const refs: ExecutableRef[] = [];
  const onRef: OnRef = (ref, offset) => refs.push({ ref, offset });
  const tokens = tokenize(content);
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    if (token.type === 'variable') {
      if (token.isStoryVariable && token.name) onRef(token.name, token.nameStart - 1);
    } else if (token.type === 'expression') {
      scanCode(token.expression, 0, token.exprStart, onRef);
    } else if (token.type === 'html') {
      for (const { value, offset } of token.values) scanInterpolations(value, offset, onRef);
    } else if (token.type === 'macro' && !token.isClose) {
      scanCode(token.rawArgs, 0, token.rawArgsStart, onRef);

      if (storeVarMacros.has(token.name.toLowerCase())) {
        const first = token.rawArgs.trim().split(/\s+/)[0] ?? '';
        const quoted = QUOTED_VAR_ARG_RE.exec(first);
        if (quoted) onRef(quoted[1], token.rawArgsStart + 1);
      }

      if (token.name === 'do') {
        // A {do} body is JavaScript: scan its source text as code.
        let close = t + 1;
        while (close < tokens.length) {
          const c = tokens[close];
          if (c.type === 'macro' && c.isClose && c.name === 'do') break;
          close++;
        }
        if (close < tokens.length) {
          const closer = tokens[close] as MacroToken;
          scanCode(content.slice(token.end, closer.start), 0, token.end, onRef);
          t = close;
        }
      }
    }
  }
  return refs;
}
