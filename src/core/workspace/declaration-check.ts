import { parseDeclarations, type Declaration } from '@rohal12/spindle/tooling';

export type DeclarationSigil = '$' | '%';

const PASSAGE = { '$': 'StoryVariables', '%': 'StoryTransients' } as const;

/** A line of StoryVariables / StoryTransients that stops Spindle from starting. */
export interface DeclarationProblem {
  message: string;
  /** Offsets of the line (without its indentation) in `DeclarationReading.text`. */
  start: number;
  end: number;
}

/** What Spindle makes of the content of a StoryVariables / StoryTransients passage. */
export interface DeclarationReading {
  /** The content as Spindle reads it: line breaks are LF, and it ends before the next `::` header line. */
  text: string;
  declarations: Declaration[];
  problems: DeclarationProblem[];
}

/**
 * Read the lines of a StoryVariables (`$`) or StoryTransients (`%`) passage
 * with `parseDeclarations`, the grammar `parseStoryVariables` reads with. A
 * line starting with `::` starts another passage for twee compilers (with or
 * without a space), so the content ends there.
 *
 * `problems` are the lines Spindle rejects, with its wording: a line that is
 * no declaration, a name no variable can have, a value no variable can hold
 * (a function, `undefined`, a BigInt), and a value that does not compile.
 * `null` is a valid default (type `null`) and a name declared twice is not
 * an error (the later wins), so neither is a problem.
 */
export function readDeclarations(content: string, sigil: DeclarationSigil): DeclarationReading {
  const passage = PASSAGE[sigil];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const header = lines.findIndex(line => /^﻿?::/.test(line));
  const text = (header === -1 ? lines : lines.slice(0, header)).join('\n');
  // A CR that is no line break of the document reaches Spindle as one (the compiler splits
  // the line there): such a line is not judged, but is not read as a part of its neighbors either
  const { declarations, errors } = parseDeclarations(text.replace(/\r/g, ' '), sigil);

  const problems: DeclarationProblem[] = [];
  const rejected = new Set<number>();
  for (const error of errors) {
    if (error.code === 'duplicate-declaration') continue;
    const [start, end] = lineSpan(text, error.offset);
    if (isUnjudged(text.slice(start, end))) continue;
    rejected.add(start);
    let message = `${passage}: ${error.message}`;
    if (error.code === 'invalid-declaration' && COMMENT_START.test(text.slice(error.offset, error.end))) {
      message += `. ${passage} has no comment syntax.`;
    } else if (!message.endsWith('.')) {
      message += '.';
    }
    problems.push({ message, start, end });
  }

  for (const declaration of declarations) {
    const [start, end] = lineSpan(text, declaration.nameStart);
    if (rejected.has(start)) continue;
    if (isUnjudged(text.slice(start, end))) continue;
    const expr = text.slice(declaration.valueStart, declaration.valueEnd);
    const error = compileError(expr);
    if (error === undefined) continue;
    const comment = compileError(expr + '\n') === undefined
      ? ' A comment runs to the end of the line and hides the ")" Spindle closes the value with;' +
        ` ${passage} has no comment syntax.`
      : '';
    problems.push({
      message: `${passage}: Failed to evaluate "${sigil}${declaration.name} = ${expr}": ${error}.${comment}`,
      start,
      end,
    });
  }
  return { text, declarations, problems: problems.sort((a, b) => a.start - b.start) };
}

const COMMENT_START = /^(?:\/\/|\/\*|<!--|#)/;

/**
 * Whether a line cannot be judged by its text: the compiler splits a line at a
 * carriage return, and the browser serialises a no-break space as `&nbsp;` in
 * the passage text Spindle reads.
 */
function isUnjudged(line: string): boolean {
  return line.includes('\r') || line.includes(' ');
}

/** The span of the line holding `offset`, without its indentation and trailing space. */
function lineSpan(text: string, offset: number): [number, number] {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = text.indexOf('\n', offset);
  const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const start = lineStart + line.length - line.trimStart().length;
  return [start, lineStart + line.trimEnd().length];
}

/**
 * The SyntaxError message of the function Spindle builds for a value, or
 * undefined if it compiles. The function is created and never called, so
 * nothing the project wrote runs. (`parseDeclarations` reads no JavaScript
 * syntax of an initializer; `parseStoryVariables` fails on it when it
 * evaluates.)
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
