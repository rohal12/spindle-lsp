import { createCodeScanner, type CodeScanner } from './code-scanner.js';
import { SELECTOR_PATTERN } from './macro-parser.js';

/**
 * A `{…}` block in an HTML attribute value that Spindle outputs as text,
 * with offsets relative to the value.
 */
export interface UnevaluatedBlock {
  start: number;
  end: number;
  /** A macro (or a whole container), or an expression that uses a variable. */
  kind: 'macro' | 'expression';
  /** For a macro, its name as written, with a slash for a closing tag (`/if`). */
  macro?: string;
}

export interface MacroLookup {
  /** Whether `{name}` is a macro or a widget. */
  isMacro(name: string): boolean;
  /** Whether `{name}` opens a container closed by `{/name}`. */
  isContainer(name: string): boolean;
}

const SIGILS = new Set(['$', '_', '@', '%']);

/** The head of a macro: closing slash or selectors, then the name. */
const MACRO_HEAD = new RegExp(String.raw`^(?:(\/)|${SELECTOR_PATTERN} )?([A-Za-z][\w-]*)(?=\s|$|\{[$_@%])`);

/**
 * A variable reference in code: a sigil and a name, not part of a longer
 * word (`foo_bar`, `user@example`, `a%b`) or member access.
 */
const VARIABLE_REFERENCE = /(?:^|[^\w$.@%])[$_@%][A-Za-z_$]/;

/**
 * Find the `{…}` blocks in an HTML attribute value that Spindle outputs as
 * text although they look like code.
 *
 * Spindle's HtmlNodeRenderer passes every attribute value through
 * interpolate() (interpolation.ts), which evaluates a `{` block only when a
 * sigil (`$ _ @ %`) follows the brace directly. Any other `{` is output as
 * text and the scan goes on with the next character, so macros
 * (rohal12/spindle#225) and expressions such as `{!$x ? 'a' : 'b'}` are
 * output as written. Same in 0.45.1 and upstream main.
 *
 * Braces are often meant as text in attributes (JSON in `data-*`, CSS,
 * templates of other libraries), so a block is only reported when it:
 *  - starts with the name of a known macro or widget, opening or closing,
 *    possibly after selectors (`{if …}`, `{/for}`, `{.c print $x}`). An
 *    opening container is reported together with its closing tag when that
 *    is in the same value, and nothing inside it is reported again;
 *  - or uses a variable outside string literals and outside nested
 *    `{$…}`-style blocks, which interpolate() does evaluate (`{!$x}`,
 *    `{($a + $b)}`, `{Math.max(_a, 0)}`).
 * A brace after a backslash is skipped: the author meant it as text.
 */
export function findUnevaluatedBlocks(value: string, lookup: MacroLookup): UnevaluatedBlock[] {
  const blocks: UnevaluatedBlock[] = [];
  if (!value.includes('{')) return blocks;
  const code = createCodeScanner(value);

  let i = 0;
  while (i < value.length) {
    i = value.indexOf('{', i);
    if (i === -1) break;
    const block = readBlock(value, code, i);
    if (block.kind === 'skip') {
      i = block.next;
      continue;
    }
    const inner = value.slice(i + 1, block.close);
    const head = MACRO_HEAD.exec(inner);
    if (head && lookup.isMacro(head[2])) {
      const closing = head[1] === '/';
      let end = block.close + 1;
      if (!closing && lookup.isContainer(head[2])) {
        end = containerEnd(value, code, end, head[2]) ?? end;
      }
      blocks.push({ start: i, end, kind: 'macro', macro: closing ? `/${head[2]}` : head[2] });
      i = end;
    } else if (usesVariable(inner)) {
      blocks.push({ start: i, end: block.close + 1, kind: 'expression' });
      i = block.close + 1;
    } else {
      // Text braces; a block nested inside may still be code
      i++;
    }
  }
  return blocks;
}

type Block = { kind: 'skip'; next: number } | { kind: 'text'; close: number };

/**
 * Classify the `{` at i: a block interpolate() evaluates or an escaped or
 * unclosed brace (skip, continuing at `next`), or a closed block it outputs
 * as text.
 */
function readBlock(value: string, code: CodeScanner, i: number): Block {
  if (i > 0 && value[i - 1] === '\\') return { kind: 'skip', next: i + 1 };
  if (SIGILS.has(value[i + 1])) {
    // 0.45.1 counts braces; later versions skip string literals. Go past both.
    const end = Math.max(plainClose(value, i + 1), code.closeBrace(i + 1));
    return { kind: 'skip', next: end === -1 ? i + 1 : end + 1 };
  }
  const close = code.closeBrace(i + 1);
  return close === -1 ? { kind: 'skip', next: i + 1 } : { kind: 'text', close };
}

/** The } a plain brace count from i (just past a {) reaches, or -1. */
function plainClose(value: string, i: number): number {
  let depth = 1;
  for (; i < value.length; i++) {
    if (value[i] === '{') depth++;
    else if (value[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** The end of the `{/name}` closing a container whose opening tag ends at `from`. */
function containerEnd(value: string, code: CodeScanner, from: number, name: string): number | undefined {
  const lower = name.toLowerCase();
  let depth = 1;
  let i = from;
  while (i < value.length) {
    i = value.indexOf('{', i);
    if (i === -1) break;
    const block = readBlock(value, code, i);
    if (block.kind === 'skip') {
      i = block.next;
      continue;
    }
    const head = MACRO_HEAD.exec(value.slice(i + 1, block.close));
    if (head && head[2].toLowerCase() === lower) {
      depth += head[1] === '/' ? -1 : 1;
      if (depth === 0) return block.close + 1;
      i = block.close + 1;
    } else {
      i++;
    }
  }
  return undefined;
}

/**
 * Whether code reads a variable outside string and template literals and
 * outside nested `{$…}` blocks.
 */
function usesVariable(inner: string): boolean {
  const code = createCodeScanner(inner);
  let masked = '';
  let i = 0;
  while (i < inner.length) {
    const literal = code.literalEnd(i);
    if (literal !== -1) {
      masked += ' '.repeat(literal - i);
      i = literal;
      continue;
    }
    if (inner[i] === '{' && SIGILS.has(inner[i + 1])) {
      const close = code.closeBrace(i + 1);
      if (close !== -1) {
        masked += ' '.repeat(close + 1 - i);
        i = close + 1;
        continue;
      }
    }
    masked += inner[i];
    i++;
  }
  return VARIABLE_REFERENCE.test(masked);
}

/** The `{if C}A{else}B{/if}` and `{if C}A{/if}` shapes conditionalExpression() rewrites. */
const IF_ELSE = /^\{if\s+([^{}]*)\}([^{}]*?)(?:\{else\s*\}([^{}]*))?\{\/if\s*\}$/;

/**
 * Rewrite an `{if C}A{else}B{/if}` (or `{if C}A{/if}`) written in an HTML
 * attribute as `{C ? 'A' : 'B'}`, which Spindle evaluates there. Returns
 * null unless the result is certain to mean the same:
 *  - C must start with a sigil and a word character, which is what makes
 *    interpolate() evaluate the block (INTERP_TEST in interpolation.ts);
 *    C cannot be wrapped in parentheses, since then it would not;
 *  - so C must bind tighter than `?:`: no `?` other than `?.` and `??`,
 *    no assignment or arrow (`=` other than in a comparison), no `,` or `;`;
 *  - C, A and B hold no braces (Spindle 0.45.1 ends the block at the first
 *    balancing `}`, even inside a string) and no line breaks; C holds no
 *    template literal.
 * A and B become single-quoted strings, with `\` and `'` escaped.
 */
export function conditionalExpression(source: string): string | null {
  const match = IF_ELSE.exec(source);
  if (!match) return null;
  const condition = match[1].trim();
  const [whenTrue, whenFalse = ''] = [match[2], match[3]];
  if (!/^[$_@%]\w/.test(condition)) return null;
  if (/[`\r\n]/.test(condition) || /[\r\n]/.test(whenTrue + whenFalse)) return null;

  const code = createCodeScanner(condition);
  let operators = '';
  for (let i = 0; i < condition.length; ) {
    const literal = code.literalEnd(i);
    if (literal !== -1) {
      i = literal;
      continue;
    }
    operators += condition[i];
    i++;
  }
  if (/(?:<<|>>)=/.test(operators)) return null;
  const rest = operators.replace(/\?\?|\?\./g, '').replace(/[!=]==?|[<>]=/g, '');
  if (/[?=,;]/.test(rest)) return null;

  const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return `{${condition} ? ${quote(whenTrue)} : ${quote(whenFalse)}}`;
}

/** A path interpolate() reads without the expression evaluator. */
const SIMPLE_PATH = /^[$_@%][\w.]+$/;

/**
 * Rewrite a `{print E}` written in an HTML attribute as `{E}`, which
 * Spindle evaluates there. {print} displays String(evaluate(E)), or ''
 * for null and undefined; interpolate() gives the same for a block whose
 * text is not a simple path. A simple path with a dot (`$o.k`) is read by
 * resolveSimple() instead, which in 0.45.1 gives '' for a property of a
 * primitive (`$s.length`), so it becomes `{E ?? ''}`, which is evaluated
 * and displays the same. Returns null unless:
 *  - the block is exactly `{print E}`, without selectors;
 *  - E starts with a sigil and a word character (INTERP_TEST in
 *    interpolation.ts), so it is not parenthesized;
 *  - E holds no braces, also not inside strings (Spindle 0.45.1 ends the
 *    block at the first balancing `}`, while {print} skips strings), and
 *    no line breaks;
 *  - E is one expression: no `,` outside brackets and strings (several
 *    arguments) and no `;` outside strings.
 * When E throws, {print} shows an error and the attribute does not render;
 * no value differs.
 */
export function printExpression(source: string): string | null {
  const match = /^\{print\s+([^{}\r\n]*)\}$/.exec(source);
  if (!match) return null;
  const expr = match[1].trim();
  if (!/^[$_@%]\w/.test(expr)) return null;

  const code = createCodeScanner(expr);
  let depth = 0;
  for (let i = 0; i < expr.length; ) {
    const literal = code.literalEnd(i);
    if (literal !== -1) {
      i = literal;
      continue;
    }
    const c = expr[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ';' || (c === ',' && depth <= 0)) return null;
    i++;
  }

  return SIMPLE_PATH.test(expr) && expr.includes('.') ? `{${expr} ?? ''}` : `{${expr}}`;
}
