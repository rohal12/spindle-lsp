export interface Passage {
  header: string;
  body: string;
  /** Line index in the original document where the header is. */
  startLine: number;
}

export interface Region {
  type: 'spindle' | 'html' | 'script';
  lines: string[];
}

const PASSAGE_HEADER_REGEX = /^::\s+/;
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Split a Twee document into passages by `::` headers.
 */
export function splitPassages(text: string): Passage[] {
  const lines = text.split('\n');
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
    if (PASSAGE_HEADER_REGEX.test(lines[i])) {
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
  const tagMatch = header.match(/\[([^\]]*)\]/g);
  if (!tagMatch) return 'normal';
  const tags = tagMatch.map(t => t.slice(1, -1).trim().toLowerCase());
  if (tags.includes('script')) return 'script';
  if (tags.includes('stylesheet')) return 'stylesheet';
  return 'normal';
}

/**
 * Segment a passage body into regions: spindle (markdown/macros), html blocks, script blocks.
 */
export function segmentRegions(body: string): Region[] {
  const lines = body.split('\n');
  // Remove trailing empty line from split
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length === 0) return [];

  const regions: Region[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect <script> blocks
    if (/^<script(\s|>)/i.test(trimmed)) {
      const scriptLines: string[] = [line];
      i++;
      while (i < lines.length && !/<\/script>/i.test(lines[i])) {
        scriptLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        scriptLines.push(lines[i]); // closing </script>
        i++;
      }
      regions.push({ type: 'script', lines: scriptLines });
      continue;
    }

    // Detect multi-line HTML blocks
    if (/^<([a-zA-Z][\w-]*)/.test(trimmed)) {
      const tagMatch = trimmed.match(/^<([a-zA-Z][\w-]*)/);
      const tagName = tagMatch![1].toLowerCase();

      // Skip void elements on their own line — not a multi-line block
      if (VOID_ELEMENTS.has(tagName) && !lines[i + 1]?.trim().startsWith('<')) {
        pushSpindleLine(regions, line);
        i++;
        continue;
      }

      // Check if this is truly multi-line: does the tag close on the same line?
      const selfClosing = new RegExp(`</${tagName}\\s*>`, 'i');
      if (selfClosing.test(trimmed)) {
        pushSpindleLine(regions, line);
        i++;
        continue;
      }

      // Multi-line HTML block
      const htmlLines: string[] = [line];
      let depth = 1;
      i++;
      while (i < lines.length && depth > 0) {
        htmlLines.push(lines[i]);
        const opens = (lines[i].match(new RegExp(`<${tagName}[\\s>]`, 'gi')) ?? []).length;
        const closes = (lines[i].match(new RegExp(`</${tagName}\\s*>`, 'gi')) ?? []).length;
        depth += opens - closes;
        i++;
      }
      regions.push({ type: 'html', lines: htmlLines });
      continue;
    }

    // Default: spindle/markdown line
    pushSpindleLine(regions, line);
    i++;
  }

  return regions;
}

/** Append a line to the last spindle region, or create a new one. */
function pushSpindleLine(regions: Region[], line: string): void {
  const last = regions[regions.length - 1];
  if (last?.type === 'spindle') {
    last.lines.push(line);
  } else {
    regions.push({ type: 'spindle', lines: [line] });
  }
}
