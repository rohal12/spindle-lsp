import type { Range } from '../types.js';
import { withoutCr } from '../text.js';

export interface ParsedPassageHeader {
  name: string;
  tags: string[];
  meta: Record<string, unknown> | undefined;
  headerRange: Range;
  nameRange: Range;
}

const SPECIAL_PASSAGES = new Set([
  'StoryVariables',
  'StoryInit',
  'StoryData',
  'StoryTitle',
  'StoryBanner',
  'StoryCaption',
  'StoryMenu',
  'StoryInterface',
  'StoryAuthor',
]);

/**
 * Parse a single line as a passage header.
 * Returns null if the line is not a valid passage header.
 */
export function parsePassageHeader(rawLine: string, lineNumber: number): ParsedPassageHeader | null {
  // A line split at LF keeps a CRLF's CR: it ends the line and is not header text
  const line = withoutCr(rawLine);
  // Run regex against escaped version (neutralize backslash sequences for matching)
  // A document's leading U+FEFF is its byte order mark: the header sits behind
  // it, and every column stays in the client's own coordinates.
  const bomLength = lineNumber === 0 && line.charCodeAt(0) === 0xfeff ? 1 : 0;
  const escaped = line.replace(/\\./g, 'ec');
  const prefix = /^::\s*/.exec(escaped.slice(bomLength));
  if (!prefix) return null;

  // A valid name contains no unescaped delimiters. Consume each section
  // once instead of retrying optional groups at every possible name boundary.
  const nameStart = bomLength + prefix[0].length;
  const delimiter = /[\[\]{}]/g;
  delimiter.lastIndex = nameStart;
  const first = delimiter.exec(escaped);
  const nameEnd = first?.index ?? line.length;
  const name = line.slice(nameStart, nameEnd).trim();
  if (!name) return null;

  let rest = nameEnd;
  let tags: string[] = [];
  if (escaped[rest] === '[') {
    const end = escaped.indexOf(']', rest + 1);
    if (end === -1 || /[\[{}]/.test(escaped.slice(rest + 1, end))) return null;
    const decoded = line.slice(rest + 1, end).replace(/\\(.)/g, '$1').trim();
    tags = decoded ? decoded.split(/\s+/) : [];
    rest = end + 1;
    while (rest < line.length && /\s/.test(escaped[rest])) rest++;
  }

  let meta: Record<string, unknown> | undefined;
  if (rest < line.length) {
    const raw = line.slice(rest).trim();
    if (escaped[rest] !== '{' || !raw.endsWith('}')) return null;
    try {
      meta = JSON.parse(raw);
    } catch {
      return null;
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
  const nameCharEnd = nameCharStart + name.length;

  const nameRange: Range = {
    start: { line: lineNumber, character: nameCharStart },
    end: { line: lineNumber, character: nameCharEnd },
  };

  return {
    name: name.replace(/\\(.)/g, '$1'), // unescape
    tags,
    meta,
    headerRange,
    nameRange,
  };
}

/** Tags whose passages hold JavaScript or CSS instead of story markup. */
const CODE_PASSAGE_TAGS = new Set(['script', 'stylesheet']);

/**
 * Passage names that carry a meaning of their own: Twee's story passages and
 * the ones Spindle reads by name at startup or around every passage. Renaming
 * such a passage (or a reference to it) silently changes the passage's role,
 * so navigation treats these names as fixed.
 */
const RESERVED_PASSAGE_NAMES: ReadonlySet<string> = new Set([
  ...SPECIAL_PASSAGES,
  'StoryTitle', 'StoryLoading', 'StoryTransients', 'StoryScript', 'SaveTitle',
  'PassageReady', 'PassageDone', 'PassageHeader', 'PassageFooter',
]);

/** Whether `name` is a passage name with a fixed meaning (see RESERVED_PASSAGE_NAMES). */
export function isReservedPassageName(name: string): boolean {
  return RESERVED_PASSAGE_NAMES.has(name);
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
}

/** Whether Spindle tokenizes the passage's body as story markup. */
export function isMarkupPassage(passage: PassageRole): boolean {
  return !(passage.name !== undefined && NON_MARKUP_PASSAGES.has(passage.name)) && !isScriptOrStylesheetPassage(passage);
}
