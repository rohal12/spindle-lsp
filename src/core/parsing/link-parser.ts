import type { Range } from '../types.js';
import { buildLineStarts, offsetToPosition } from './macro-parser.js';

export interface PassageRef {
  name: string;
  range: Range;
  source: 'link' | 'macro';
}

/**
 * Skip a `.class#id` selector prefix starting at `i`, the way Spindle's
 * tokenizer does for `[[.cls#id ...]]` links (including `{$var}`, `{_var}`
 * and `{@var}` interpolations inside a selector name).
 * Returns the index after the last selector.
 */
function skipSelectors(text: string, i: number): number {
  while (text[i] === '.' || text[i] === '#') {
    i++;
    for (;;) {
      if (/[a-zA-Z0-9_-]/.test(text[i] ?? '')) {
        i++;
        continue;
      }
      const interpolation = /^\{[$_@][\w.]*\}/.exec(text.slice(i));
      if (!interpolation) break;
      i += interpolation[0].length;
    }
  }
  return i;
}

/**
 * Locate the target inside a link's inner text, mirroring Spindle's
 * `parseLink`: `display|target`, then `display->target`, then
 * `target<-display`, else the whole text. Returns offsets relative to
 * `inner`, with surrounding whitespace excluded.
 */
function locateTarget(inner: string): { start: number; end: number } {
  let start = 0;
  let end = inner.length;

  const pipeIdx = inner.indexOf('|');
  const arrowIdx = inner.indexOf('->');
  const revIdx = inner.indexOf('<-');
  if (pipeIdx !== -1) {
    start = pipeIdx + 1;
  } else if (arrowIdx !== -1) {
    start = arrowIdx + 2;
  } else if (revIdx !== -1) {
    end = revIdx;
  }

  while (start < end && /\s/.test(inner[start])) start++;
  while (end > start && /\s/.test(inner[end - 1])) end--;
  return { start, end };
}

/**
 * Parse all passage references from bracket links in the given text.
 *
 * Follows Spindle's tokenizer: an optional `.class#id ` prefix after `[[`,
 * nested `[[...]]` inside the link, and the target forms
 *   [[PassageName]]
 *   [[Display Text|Target]]
 *   [[Display Text->Target]]
 *   [[Target<-Display Text]]
 *
 * @param text - the text to parse
 * @param lineOffset - optional line offset added to all line numbers (default 0)
 */
export function parseLinks(text: string, lineOffset: number = 0): PassageRef[] {
  const lineStarts = buildLineStarts(text);
  const refs: PassageRef[] = [];

  let i = text.indexOf('[[');
  while (i !== -1) {
    const linkStart = i;
    i += 2;
    if (text[i] === '.' || text[i] === '#') {
      i = skipSelectors(text, i);
      if (text[i] === ' ') i++;
    }

    // Find the closing ]], allowing nested [[...]]
    const innerStart = i;
    let depth = 1;
    while (i < text.length) {
      if (text.startsWith('[[', i)) {
        depth++;
        i += 2;
      } else if (text.startsWith(']]', i)) {
        if (--depth === 0) break;
        i += 2;
      } else {
        i++;
      }
    }

    if (depth !== 0) {
      // Unclosed link: Spindle treats it as text and rescans after `[[`
      i = text.indexOf('[[', linkStart + 2);
      continue;
    }

    const target = locateTarget(text.slice(innerStart, i));
    if (target.end > target.start) {
      const nameStart = innerStart + target.start;
      const nameEnd = innerStart + target.end;
      const startPos = offsetToPosition(nameStart, lineStarts);
      const endPos = offsetToPosition(nameEnd, lineStarts);

      refs.push({
        name: text.slice(nameStart, nameEnd),
        range: {
          start: { line: startPos.line + lineOffset, character: startPos.character },
          end: { line: endPos.line + lineOffset, character: endPos.character },
        },
        source: 'link',
      });
    }

    i = text.indexOf('[[', i + 2);
  }

  return refs;
}
