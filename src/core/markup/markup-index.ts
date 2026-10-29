import type { Passage } from '../types.js';
import { DocumentMarkup, type MarkupContext } from './passage-markup.js';

/** What the index reads from the workspace. */
export interface MarkupSources {
  text(uri: string): string | undefined;
  /** Reuse the indexed array until a rebuild; replace it when headers change. */
  passages(uri: string): readonly Passage[];
  context(): MarkupContext;
}

/**
 * The markup of every document, read once per version of its text and of the
 * project's macros and widgets. Consumers ask `get(uri)` for what they need
 * (tokens, the paired tree, pieces) instead of scanning text themselves.
 */
export class MarkupIndex {
  private readonly cache = new Map<string, { markup: DocumentMarkup; headers: readonly Passage[] }>();
  private context: MarkupContext | undefined;

  constructor(private readonly sources: MarkupSources) {}

  /** The markup of document `uri`, or undefined if it is not open. */
  get(uri: string): DocumentMarkup | undefined {
    const text = this.sources.text(uri);
    if (text === undefined) return undefined;
    const kept = this.cache.get(uri);
    const passages = this.sources.passages(uri);
    // PassageIndex replaces its array on rebuild. Empty results may be fresh
    // arrays, but have no header identities to invalidate.
    if (kept && kept.markup.text === text && (kept.headers === passages ||
      (kept.headers.length === 0 && passages.length === 0))) return kept.markup;
    this.context ??= this.sources.context();
    const fresh = new DocumentMarkup(uri, text, passages, this.context);
    this.cache.set(uri, { markup: fresh, headers: passages });
    return fresh;
  }

  /** The macros or widgets changed: every document's markup is read again on demand. */
  invalidate(): void {
    this.cache.clear();
    this.context = undefined;
  }
}
