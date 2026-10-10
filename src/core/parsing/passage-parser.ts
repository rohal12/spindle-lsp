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
  // A document's leading U+FEFF is its byte order mark: the header sits behind
  // it, and every column stays in the client's own coordinates.
  const bomLength = lineNumber === 0 && line.charCodeAt(0) === 0xfeff ? 1 : 0;
  const escaped = line.slice(bomLength).replace(/\\./g, 'ec');
  const match = passageHeaderRegex.exec(escaped);
  if (!match) return null;

  const prefix = line.slice(0, bomLength) + (match[1] ?? ''); // "\uFEFF:: "
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
