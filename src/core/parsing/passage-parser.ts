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
