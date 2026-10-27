import type { Range } from '../types.js';
import { createRequire as createCompilerRequire } from 'node:module';
import { isSpecialPassage } from '@rohal12/spindle/tooling';
import { withoutCr } from '../text.js';

export interface ParsedPassageHeader {
  name: string;
  tags: string[];
  meta: Record<string, unknown> | undefined;
  headerRange: Range;
  nameRange: Range;
}

/** Encode a name only when the compiler reads back exactly that identity. */
export function encodePassageName(name: string): string | undefined {
  if (!name || /[\r\n]/.test(name)) return undefined;
  const encoded = name.replace(/[[\]{}\\]/g, '\\$&');
  const { parseTwee } = createCompilerRequire(import.meta.url)('@rohal12/twee-ts') as typeof import('@rohal12/twee-ts');
  const parsed = parseTwee(`:: ${encoded}`);
  return parsed.passages.length === 1 && parsed.passages[0].name === name
    && !parsed.diagnostics.some(d => d.level === 'error') ? encoded : undefined;
}

/**
 * Parse a single line as a passage header.
 * Returns null if the line is not a valid passage header.
 */
export function parsePassageHeader(rawLine: string, lineNumber: number): ParsedPassageHeader | null {
  // A line split at LF keeps a CRLF's CR: it ends the line and is not header text
  const line = withoutCr(rawLine);
  // Run regex against escaped version (neutralize backslash sequences for matching)
  // The compiler accepts BOM-prefixed headers in concatenated files too.
  // Keep every column in the client's original coordinates.
  const bomLength = /^\uFEFF*/.exec(line)![0].length;
  const escaped = line.replace(/\\./g, 'ec');
  // Twee uses Go/Unicode White_Space, not JavaScript whitespace (FEFF/NEL).
  const prefix = /^::\p{White_Space}*/u.exec(escaped.slice(bomLength));
  if (!prefix) return null;

  // A valid name contains no unescaped delimiters. Consume each section
  // once instead of retrying optional groups at every possible name boundary.
  const nameStart = bomLength + prefix[0].length;
  const delimiter = /[\[\]{}]/g;
  delimiter.lastIndex = nameStart;
  const first = delimiter.exec(escaped);
  const boundary = first?.index ?? line.length;
  // Trim structural whitespace in the masked source so an escaped trailing
  // space stays in the edit range. The compiler trims the decoded name.
  const nameEnd = escaped.slice(0, boundary).replace(/\p{White_Space}+$/u, '').length;
  const name = line.slice(nameStart, nameEnd).replace(/\\(.|$)/g, '$1').replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  if (!name) return null;

  let rest = boundary;
  let tags: string[] = [];
  if (escaped[rest] === '[') {
    const end = escaped.indexOf(']', rest + 1);
    if (end === -1 || /[\[{}]/.test(escaped.slice(rest + 1, end))) return null;
    const decoded = line.slice(rest + 1, end).replace(/\\(.)/g, '$1');
    tags = decoded.match(/[^\p{White_Space}]+/gu) ?? [];
    rest = end + 1;
    while (rest < line.length && /\p{White_Space}/u.test(escaped[rest])) rest++;
  }

  let meta: Record<string, unknown> | undefined;
  if (rest < line.length) {
    const raw = line.slice(rest).replace(/\p{White_Space}+$/u, '');
    if (escaped[rest] !== '{' || !raw.endsWith('}')) return null;
    try {
      meta = JSON.parse(raw);
    } catch {
      // Metadata decoding is a compiler warning, not a lost passage boundary.
      // Ask the compiler about this line alone so malformed delimiters or
      // extra optional blocks still reject the header without a second lexer.
      const { parseTwee } = createCompilerRequire(import.meta.url)('@rohal12/twee-ts') as typeof import('@rohal12/twee-ts');
      if (parseTwee(line.slice(bomLength)).passages.length !== 1) return null;
    }
  }

  const headerRange: Range = {
    start: { line: lineNumber, character: 0 },
    end: { line: lineNumber, character: line.length },
  };

  // nameRange: position of the trimmed name within the line
  // The name starts right after the prefix, but the prefix may include extra whitespace.
  // We need to find where the actual name text starts (after ":: " which is the prefix).
  const nameCharStart = nameStart;
  const nameCharEnd = nameEnd;

  const nameRange: Range = {
    start: { line: lineNumber, character: nameCharStart },
    end: { line: lineNumber, character: nameCharEnd },
  };

  return {
    name,
    tags,
    meta,
    headerRange,
    nameRange,
  };
}

/** Tags whose passages hold JavaScript or CSS instead of story markup. */
const CODE_PASSAGE_TAGS = new Set(['script', 'stylesheet']);

/**
 * Passage names that carry a meaning of their own: Spindle's special passages,
 * which it reads by name at startup or around every passage (its
 * `isSpecialPassage`), and Twee's story passages below. Renaming such a
 * passage (or a reference to it) silently changes the passage's role, so
 * navigation treats these names as fixed.
 */
const TWEE_PASSAGE_NAMES: ReadonlySet<string> = new Set([
  'StoryData', 'StoryTitle', 'StoryScript',
  'StoryBanner', 'StoryCaption', 'StoryMenu', 'StoryAuthor',
  // twee-ts also reads these legacy compiler metadata passages by name.
  'StorySettings', 'StoryIncludes',
]);

/** Whether `name` is a passage name with a fixed meaning (see TWEE_PASSAGE_NAMES). */
export function isReservedPassageName(name: string): boolean {
  return isSpecialPassage(name) || TWEE_PASSAGE_NAMES.has(name);
}

/**
 * Check whether a passage is a `script` or `stylesheet` passage. Its body is
 * compiled as JavaScript/CSS, not rendered as story markup, so story syntax
 * checks do not apply to it.
 */
export function isScriptOrStylesheetPassage(passage: { tags?: string[] }): boolean {
  return passage.tags?.some(t => CODE_PASSAGE_TAGS.has(t)) ?? false;
}

/**
 * Passages that Spindle never tokenizes as markup. The compiler turns
 * StoryTitle and StoryData into story attributes; Spindle reads
 * StoryVariables and StoryTransients as declarations (parseStoryVariables)
 * and runs SaveTitle as a JavaScript function body. Script and stylesheet
 * passages become the story's JavaScript and CSS. Every other passage can
 * be rendered: Spindle tokenizes StoryInit, StoryInterface, StoryLoading
 * and the Passage* passages itself, widget passages at startup, and any
 * passage it navigates to, includes or opens in a dialog.
 */
const NON_MARKUP_PASSAGES: ReadonlySet<string> = new Set([
  'StoryTitle', 'StoryData', 'StoryVariables', 'StoryTransients', 'SaveTitle',
]);

/** What the role of a passage depends on. */
export interface PassageRole {
  name?: string;
  tags?: string[];
  runtimeOmitted?: boolean;
}

/** Source passages compiled into attributes, code or private drafts have no runtime destination. */
export function isRuntimePassage(passage: PassageRole): boolean {
  return !passage.runtimeOmitted && passage.name !== 'StoryTitle' && passage.name !== 'StoryData'
    && !isScriptOrStylesheetPassage(passage) && !passage.tags?.includes('Twine.private');
}

/** Whether Spindle tokenizes the passage's body as story markup. */
export function isMarkupPassage(passage: PassageRole): boolean {
  return isRuntimePassage(passage) && !(passage.name !== undefined && NON_MARKUP_PASSAGES.has(passage.name));
}
