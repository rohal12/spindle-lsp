import type { Range } from '../types.js';

export interface ParsedPassageHeader {
  name: string;
  tags: string[];
  meta: Record<string, unknown> | undefined;
  headerRange: Range;
  nameRange: Range;
}

/**
 * Regex for matching passage headers.
 * Captures: (1) `:: ` prefix, (2) passage name, (3) optional `[tags]`, (4) optional `{meta}`
 *
 * Derived from the reference in twee3-language-tools/src/parse-text.ts:
 *   /(^::\s*)(.*?)(\[.*?\]\s*)?(\{.*?\}\s*)?\r?$/
 */
const passageHeaderRegex = /^(::\s+)(.*?)(\[.*?\]\s*)?(\{.*?\}\s*)?\r?$/;

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
export function parsePassageHeader(line: string, lineNumber: number): ParsedPassageHeader | null {
  // Run regex against escaped version (neutralize backslash sequences for matching)
  const escaped = line.replace(/\\./g, 'ec');
  const match = passageHeaderRegex.exec(escaped);
  if (!match) return null;

  const prefix = match[1] ?? '';       // ":: "
  const rawName = match[2] ?? '';      // everything between prefix and tags/meta
  const rawTags = match[3] ?? '';      // "[tag1 tag2] " or ""
  const rawMeta = match[4] ?? '';      // '{"key":"val"} ' or ""

  // Extract the actual name from the original line (not escaped)
  const nameStart = prefix.length;
  const nameEnd = nameStart + rawName.length;
  const name = line.substring(nameStart, nameEnd).trim();

  if (!name) return null;

  // Reject names with unescaped meta characters
  const escapedName = name.replace(/\\./g, 'ec');
  if (/[\[\]\{\}]/.test(escapedName)) return null;

  // Parse tags
  const tagsStr = rawTags.trim();
  let tags: string[] = [];
  if (tagsStr) {
    const inner = tagsStr.substring(1, tagsStr.length - 1).trim();
    // Reject unescaped meta characters inside tags
    if (/[\[\]\{\}]/.test(inner.replace(/\\./g, 'ec'))) return null;
    tags = inner ? inner.split(/\s+/) : [];
  }

  // Parse meta JSON
  let meta: Record<string, unknown> | undefined;
  const metaStr = rawMeta.trim();
  if (metaStr) {
    try {
      meta = JSON.parse(line.substring(nameStart + rawName.length + rawTags.length, nameStart + rawName.length + rawTags.length + rawMeta.length).trim());
    } catch {
      // Invalid JSON — treat the entire line as not a valid passage header
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
  const nameCharStart = prefix.length;
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

/**
 * Check whether a passage name is one of the special/system passages.
 */
export function isSpecialPassage(name: string): boolean {
  return SPECIAL_PASSAGES.has(name);
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
export const NON_MARKUP_PASSAGES: ReadonlySet<string> = new Set([
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

/**
 * Replace the body of every passage Spindle does not tokenize as markup
 * (see isMarkupPassage()) with spaces, keeping line breaks so offsets and
 * positions are unchanged. This is the one masking every consumer of
 * macros, links and widget calls shares, so that code or data in such a
 * passage is never read as markup. `range.start.line` is the header line.
 */
export function maskNonMarkupPassages(text: string, passages: Array<PassageRole & { range: Range }>): string {
  const excluded = passages.filter(passage => !isMarkupPassage(passage));
  // Text before the first header belongs to no passage: the compiler ignores it
  const prelude = passages.length > 0 ? Math.min(...passages.map(p => p.range.start.line)) : 0;
  if (excluded.length === 0 && prelude === 0) return text;

  const lines = text.split('\n');
  for (let i = 0; i < Math.min(prelude, lines.length); i++) lines[i] = lines[i].replace(/[^\r]/g, ' ');
  for (const passage of excluded) {
    const last = Math.min(passage.range.end.line, lines.length - 1);
    for (let i = passage.range.start.line + 1; i <= last; i++) {
      lines[i] = lines[i].replace(/[^\r]/g, ' ');
    }
  }
  return lines.join('\n');
}

/** A line starting with `::` (lines end at `\n`, as everywhere else in the server). */
export const HAS_PASSAGE_HEADER = /(?<![^\n])::/;
const PASSAGE_HEADER_LINE = /(?<![^\n])::[^\r\n]*/g;

/** A passage body of a Twee document: the text between two header lines. */
export interface PassageBody {
  /** Offset of the first character after the header line (its line start). */
  start: number;
  /** Offset of the next header line, or the end of the text. */
  end: number;
  /** Line of `start`. */
  line: number;
}

/**
 * Split a Twee document at its passage header lines (a line starting with
 * `::`). Spindle renders each passage on its own, so the tokenizer never
 * reads a macro, link or tag across a header; the header lines themselves are
 * not in any body. Text before the first header is one body, as for a text
 * that is a single passage's content.
 */
export function passageBodies(text: string): PassageBody[] {
  const bodies: PassageBody[] = [];
  let start = 0;
  let line = 0;
  for (const header of text.matchAll(PASSAGE_HEADER_LINE)) {
    if (header.index > start) bodies.push({ start, end: header.index, line });
    // Count the lines up to the one after the header
    line += countLines(text, start, header.index) + 1;
    const newline = text.indexOf('\n', header.index);
    start = newline === -1 ? text.length : newline + 1;
  }
  if (start < text.length) bodies.push({ start, end: text.length, line });
  return bodies;
}

function countLines(text: string, from: number, to: number): number {
  let count = 0;
  for (let i = text.indexOf('\n', from); i !== -1 && i < to; i = text.indexOf('\n', i + 1)) count++;
  return count;
}
