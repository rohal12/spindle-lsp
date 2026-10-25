import { splitLines } from '../../core/text.js';
import { parsePassageHeader } from '../../core/parsing/passage-parser.js';

export interface Passage {
  header: string;
  body: string;
  /** Line index in the original document where the header is. */
  startLine: number;
}

/**
 * Split a Twee document into passages by `::` headers.
 */
export function splitPassages(text: string): Passage[] {
  const lines = splitLines(text);
  // Remove trailing empty string from split (artifact of trailing \n)
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const passages: Passage[] = [];
  let currentHeader = '';
  let bodyLines: string[] = [];
  let startLine = 0;

  function pushPassage() {
    if (currentHeader || bodyLines.length > 0) {
      // Strip trailing blank lines that serve as separators between passages
      while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
        bodyLines.pop();
      }
      passages.push({
        header: currentHeader,
        body: bodyLines.join('\n') + (bodyLines.length > 0 ? '\n' : ''),
        startLine,
      });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (parsePassageHeader(lines[i], i)) {
      pushPassage();
      currentHeader = lines[i];
      bodyLines = [];
      startLine = i;
    } else {
      bodyLines.push(lines[i]);
    }
  }

  pushPassage();
  return passages;
}

/**
 * Classify a passage by its tags.
 */
export function classifyPassage(header: string): 'script' | 'stylesheet' | 'normal' {
  const tags = headerTags(header);
  if (tags.includes('script')) return 'script';
  if (tags.includes('stylesheet')) return 'stylesheet';
  return 'normal';
}

/**
 * The tags of a passage header. Uses the passage parser, so escaped `\[`
 * in the name and brackets inside the metadata are not tags. For a header
 * the parser rejects (e.g. invalid metadata JSON), fall back to the
 * bracketed lists outside backslash escapes.
 */
function headerTags(header: string): string[] {
  const parsed = parsePassageHeader(header, 0);
  if (parsed) return parsed.tags;
  const unescaped = header.replace(/\\./g, 'ec');
  // A bracket holds a whitespace-separated tag list: `[script extra]`
  return (unescaped.match(/\[[^\]]*\]/g) ?? []).flatMap(t => t.slice(1, -1).split(/\s+/));
}
