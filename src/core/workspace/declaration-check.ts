import { findUnsupportedValue } from './variable-schema.js';

export type DeclarationSigil = '$' | '%';

/**
 * Why Spindle's parseStoryVariables() (story-variables.ts) throws on a line
 * of StoryVariables (`$`) or StoryTransients (`%`), which stops the story
 * from starting. Messages use Spindle's wording.
 */
export type DeclarationProblem =
  /** The line is not `$name = value`. */
  | { kind: 'invalid'; message: string }
  /** The value does not compile. */
  | { kind: 'evaluate'; message: string }
  /** The value is undefined, a function or a bigint. */
  | { kind: 'unsupported'; message: string }
  /**
   * The value, or the object field at `field`, is null. Offsets of the
   * `null` in the line.
   */
  | { kind: 'null'; field: string[]; start: number; end: number };

/** Spindle's declarationRegex(): a `\w+` name, and a value on the same line. */
const DECLARATION_RE = { '$': /^\$(\w+)\s*=\s*(.+)$/, '%': /^%(\w+)\s*=\s*(.+)$/ } as const;

const PASSAGE = { '$': 'StoryVariables', '%': 'StoryTransients' } as const;

/**
 * The name a line declares, read as Spindle reads it; undefined for a line
 * Spindle rejects as no declaration.
 */
export function declaredName(line: string, sigil: DeclarationSigil): string | undefined {
  return DECLARATION_RE[sigil].exec(line.trim())?.[1];
}

/**
 * The problem Spindle has with one line of StoryVariables or StoryTransients,
 * if it certainly has one. Spindle reads each line on its own: it trims it,
 * skips it if blank and otherwise requires a declaration whose value it
 * evaluates with `new Function('return (' + value + ')')()`, then rejects
 * values of an unsupported type.
 *
 * Nothing here runs the value. Compiling it with the Function constructor,
 * without calling the result, is how a syntax error is found: the same parse
 * Spindle's call does, with the same wrapper. Errors that only evaluating
 * shows (an undefined name, a throwing call) are not reported.
 *
 * Returns undefined for lines it cannot judge with certainty: a line with a
 * carriage return inside (the compiler splits it in two) or a no-break space
 * (the browser serialises it as `&nbsp;` in the passage text Spindle reads).
 */
export function checkDeclaration(rawLine: string, sigil: DeclarationSigil): DeclarationProblem | undefined {
  const line = rawLine.trim();
  if (!line || line.includes('\r') || line.includes('\u00a0')) return undefined;
  const passage = PASSAGE[sigil];

  const match = DECLARATION_RE[sigil].exec(line);
  if (!match) {
    const comment = /^(?:\/\/|\/\*|<!--|#)/.test(line) ? ` ${passage} has no comment syntax.` : '';
    return {
      kind: 'invalid',
      message: `${passage}: Invalid declaration: "${line}". Expected: ${sigil}name = value.${comment}`,
    };
  }

  const [, name, expr] = match;
  const error = compileError(expr);
  if (error !== undefined) {
    const comment = compileError(expr + '\n') === undefined
      ? ' A comment runs to the end of the line and hides the ")" Spindle closes the value with;' +
        ` ${passage} has no comment syntax.`
      : '';
    return {
      kind: 'evaluate',
      message: `${passage}: Failed to evaluate "${sigil}${name} = ${expr}": ${error}.${comment}`,
    };
  }

  const value = findUnsupportedValue(expr);
  if (!value) return undefined;
  const exprStart = rawLine.length - rawLine.trimStart().length + line.length - expr.length;
  if (value.type === 'object') {
    return { kind: 'null', field: value.path, start: exprStart + value.start, end: exprStart + value.end };
  }
  const where = value.path.length > 0 ? ` (${sigil}${[name, ...value.path].join('.')})` : '';
  return {
    kind: 'unsupported',
    message: `${passage}: Unsupported type "${value.type}" for value ${value.text}${where}. ` +
      'Expected number, string, boolean, array, or object.',
  };
}

/**
 * The SyntaxError message of the function Spindle builds for a value, or
 * undefined if it compiles. The function is created and never called.
 *
 * A regular expression error is not reported: browsers add regular
 * expression syntax (flags, groups) that an older Node may not know yet.
 */
function compileError(expr: string): string | undefined {
  try {
    new Function('return (' + expr + ')');
    return undefined;
  } catch (err) {
    if (!(err instanceof SyntaxError) || /regular expression/i.test(err.message)) return undefined;
    return err.message;
  }
}
