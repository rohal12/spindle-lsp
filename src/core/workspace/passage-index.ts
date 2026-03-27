import type { Passage, Range } from '../types.js';
import { parsePassageHeader } from '../parsing/passage-parser.js';

/**
 * Maintains an index of all passages across all open documents.
 * Supports lookup by name, URI, line number, and detects duplicates.
 */
export class PassageIndex {
  /** Per-URI list of passages. */
  private byUri = new Map<string, Passage[]>();

  /**
   * Parse all passage headers in the given document text and
   * store them, replacing any previous entries for this URI.
   */
  rebuild(uri: string, text: string): void {
    // Remove old entries for this URI
    this.byUri.delete(uri);

    const lines = text.split('\n');
    const passages: Passage[] = [];

    for (let i = 0; i < lines.length; i++) {
      const header = parsePassageHeader(lines[i], i);
      if (!header) continue;

      // Compute the end of the passage content:
      // it extends until the next passage header or end of file.
      // For now, headerEnd is just the header line range.
      const passage: Passage = {
        name: header.name,
        range: {
          start: { line: i, character: 0 },
          end: { line: i, character: lines[i].length }, // will be extended below
        },
        headerEnd: header.headerRange,
        uri,
        tags: header.tags.length > 0 ? header.tags : undefined,
        meta: header.meta,
      };
      passages.push(passage);
    }

    // Extend each passage range to cover content until the next header
    for (let i = 0; i < passages.length; i++) {
      const nextStart = i + 1 < passages.length
        ? passages[i + 1].range.start.line - 1
        : lines.length - 1;
      passages[i].range = {
        start: passages[i].range.start,
        end: { line: nextStart, character: lines[nextStart]?.length ?? 0 },
      };
    }

    if (passages.length > 0) {
      this.byUri.set(uri, passages);
    }
  }

  /** Remove all passages for a URI. */
  remove(uri: string): void {
    this.byUri.delete(uri);
  }

  /** Get a passage by name. Returns the first match found. */
  getPassage(name: string): Passage | undefined {
    for (const passages of this.byUri.values()) {
      for (const p of passages) {
        if (p.name === name) return p;
      }
    }
    return undefined;
  }

  /** Get the passage containing a specific line in a document. */
  getPassageAt(uri: string, line: number): Passage | undefined {
    const passages = this.byUri.get(uri);
    if (!passages) return undefined;

    // Find the passage whose range contains this line
    for (let i = passages.length - 1; i >= 0; i--) {
      if (passages[i].range.start.line <= line) {
        return passages[i];
      }
    }
    return undefined;
  }

  /** Get all passages in a specific document. */
  getPassagesInDocument(uri: string): Passage[] {
    return this.byUri.get(uri) ?? [];
  }

  /** Get all passages across all documents. */
  getAllPassages(): Passage[] {
    const result: Passage[] = [];
    for (const passages of this.byUri.values()) {
      result.push(...passages);
    }
    return result;
  }

  /** Get the StoryVariables passage, if any. */
  getStoryVariables(): Passage | undefined {
    return this.getPassage('StoryVariables');
  }

  /** Get the StoryTransients passage, if any. */
  getStoryTransients(): Passage | undefined {
    return this.getPassage('StoryTransients');
  }

  /** Get the StoryInit passage, if any. */
  getStoryInit(): Passage | undefined {
    return this.getPassage('StoryInit');
  }

  /**
   * Find passage names that appear more than once across all documents.
   * Returns a map from name to the list of duplicate Passage objects.
   */
  getDuplicates(): Map<string, Passage[]> {
    const byName = new Map<string, Passage[]>();
    for (const passages of this.byUri.values()) {
      for (const p of passages) {
        const existing = byName.get(p.name);
        if (existing) {
          existing.push(p);
        } else {
          byName.set(p.name, [p]);
        }
      }
    }

    const duplicates = new Map<string, Passage[]>();
    for (const [name, passages] of byName) {
      if (passages.length > 1) {
        duplicates.set(name, passages);
      }
    }
    return duplicates;
  }
}
