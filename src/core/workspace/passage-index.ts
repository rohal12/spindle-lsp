import type { Passage } from '../types.js';
import { parsePassageHeader } from '../parsing/passage-parser.js';
import { splitLines } from '../text.js';
import { createRequire as createSettingsRequire } from 'node:module';

/** Folder compilation walks entries by UTF-8 name, descending before the next sibling. */
function compareSourceUris(left: string, right: string): number {
  const a = left.split('/').map(decodeURIComponent);
  const b = right.split('/').map(decodeURIComponent);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = Buffer.compare(Buffer.from(a[i], 'utf8'), Buffer.from(b[i], 'utf8'));
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

/**
 * Maintains an index of all passages across all open documents.
 * Supports lookup by name, URI, line number, and detects duplicates.
 */
export class PassageIndex {
  /** Per-URI list of passages. */
  private byUri = new Map<string, Passage[]>();

  /** The documents' URIs in a fixed (sorted) order, so lookups never depend on the order documents were opened. */
  private sortedUris: string[] | null = null;
  private uris(): string[] {
    return (this.sortedUris ??= [...this.byUri.keys()].sort());
  }

  /**
   * Parse all passage headers in the given document text and
   * store them, replacing any previous entries for this URI.
   */
  rebuild(uri: string, text: string): void {
    // Remove old entries for this URI
    this.byUri.delete(uri);
    this.sortedUris = null;

    const lines = splitLines(text);
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
        nameRange: header.nameRange,
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
      if (passages[i].name === 'StorySettings') {
        // Let the public compiler decode legacy settings, including obsolete
        // or malformed entries that leave no settings to emit.
        const { StoryBuilder } = createSettingsRequire(import.meta.url)('@rohal12/twee-ts') as typeof import('@rohal12/twee-ts');
        const builder = new StoryBuilder();
        builder.add({ name: 'StorySettings', tags: [], text: lines.slice(passages[i].headerEnd.end.line + 1, nextStart + 1).join('\n') }, []);
        passages[i].runtimeOmitted = builder.build().twine1.settings.size === 0;
      }
    }

    if (passages.length > 0) {
      this.byUri.set(uri, passages);
      this.sortedUris = null;
    }
  }

  /** Remove all passages for a URI. */
  remove(uri: string): void {
    this.byUri.delete(uri);
    this.sortedUris = null;
  }

  /**
   * Get a passage by name. A name declared more than once resolves to the
   * first declaration by document URI, then by line, whatever order the
   * documents were opened in.
   */
  getPassage(name: string): Passage | undefined {
    for (const uri of this.uris()) {
      for (const p of this.byUri.get(uri)!) {
        if (p.name === name) return p;
      }
    }
    return undefined;
  }

  /** Every declaration of a passage name, in the order getPassage() prefers them. */
  getPassages(name: string): Passage[] {
    const found: Passage[] = [];
    for (const uri of this.uris()) {
      for (const p of this.byUri.get(uri)!) {
        if (p.name === name) found.push(p);
      }
    }
    return found;
  }

  /** The compiler replaces duplicate passages with the later source declaration. */
  getEffectivePassage(name: string): Passage | undefined {
    return this.getPassages(name).sort((a, b) => compareSourceUris(a.uri, b.uri)).at(-1);
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

  /** The documents that hold a passage, in sorted URI order (never the order they were opened in). */
  getDocumentUris(): readonly string[] {
    return this.uris();
  }

  private getAllPassagesByUri(): Passage[][] {
    return this.uris().map(uri => this.byUri.get(uri)!);
  }

  /** Get all passages across all documents. */
  getAllPassages(): Passage[] {
    const result: Passage[] = [];
    for (const uri of this.uris()) {
      result.push(...this.byUri.get(uri)!);
    }
    return result;
  }

  /** Get the StoryVariables passage, if any. */
  getStoryVariables(): Passage | undefined {
    return this.getEffectivePassage('StoryVariables');
  }

  /** Get the StoryTransients passage, if any. */
  getStoryTransients(): Passage | undefined {
    return this.getEffectivePassage('StoryTransients');
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
    for (const passages of this.getAllPassagesByUri()) {
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
