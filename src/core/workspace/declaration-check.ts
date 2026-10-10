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
 * (a function, `undefined`, a BigInt) and a value that does not compile
 * (`syntax`, found by the tooling API without running anything).
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
  for (const error of errors) {
    if (error.code === 'duplicate-declaration') continue;
    const [start, end] = lineSpan(text, error.offset);
    if (isUnjudged(text.slice(start, end))) continue;
    let message = `${passage}: ${error.message}`;
    if (error.code === 'invalid-declaration' && COMMENT_START.test(text.slice(error.offset, error.end))) {
      message += `. ${passage} has no comment syntax.`;
    } else if (!message.endsWith('.')) {
      message += '.';
    }
    problems.push({ message, start, end });
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
