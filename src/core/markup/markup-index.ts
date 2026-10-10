import type { Passage } from '../types.js';
import { DocumentMarkup, type MarkupContext } from './passage-markup.js';

/** What the index reads from the workspace. */
export interface MarkupSources {
  text(uri: string): string | undefined;
  passages(uri: string): Passage[];
  context(): MarkupContext;
}

/**
 * The markup of every document, read once per version of its text and of the
 * project's macros and widgets. Consumers ask `get(uri)` for what they need
 * (tokens, the paired tree, pieces) instead of scanning text themselves.
 */
export class MarkupIndex {
  private readonly cache = new Map<string, DocumentMarkup>();
  private context: MarkupContext | undefined;

  constructor(private readonly sources: MarkupSources) {}

  /** The markup of document `uri`, or undefined if it is not open. */
  get(uri: string): DocumentMarkup | undefined {
    const text = this.sources.text(uri);
    if (text === undefined) return undefined;
    const kept = this.cache.get(uri);
    const passages = this.sources.passages(uri);
    if (kept && kept.text === text && sameHeaders(kept.passages.map(p => p.passage), passages)) return kept;
    this.context ??= this.sources.context();
    const fresh = new DocumentMarkup(uri, text, passages, this.context);
    this.cache.set(uri, fresh);
    return fresh;
  }

  /** The macros or widgets changed: every document's markup is read again on demand. */
  invalidate(): void {
    this.cache.clear();
    this.context = undefined;
  }

  /** A document was closed. */
  remove(uri: string): void {
    this.cache.delete(uri);
  }
}

function sameHeaders(a: readonly Passage[], b: readonly Passage[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}
