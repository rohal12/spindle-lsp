import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * A leading U+FEFF is the file's byte order mark, not story text: the
 * compiler reads `:: Name` behind it as a passage header. The store keeps the
 * text exactly as the client or the disk delivered it so that every position
 * the server computes is in the client's coordinates; the header recognisers
 * skip the BOM instead. Use this only for analysis that reports no positions.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

interface DocumentEntry {
  text: string;
  version: number;
}

/**
 * In-memory store for open document contents.
 * Emits events when documents are opened, changed, or closed.
 */
export class DocumentStore extends EventEmitter {
  private docs = new Map<string, DocumentEntry>();

  /** Open a document (or replace if already open). */
  open(uri: string, text: string, version?: number): void {
    this.docs.set(uri, { text, version: version ?? 0 });
    this.emit('documentOpened', uri);
  }

  /** Update an already-open document's text. */
  update(uri: string, text: string, version?: number): void {
    const existing = this.docs.get(uri);
    const newVersion = version ?? (existing ? existing.version + 1 : 0);
    this.docs.set(uri, { text, version: newVersion });
    this.emit('documentChanged', uri);
  }

  /** Close a document and remove it from the store. */
  close(uri: string): void {
    this.docs.delete(uri);
    this.emit('documentClosed', uri);
  }

  /** Get the text of a document, or undefined if not open. */
  getText(uri: string): string | undefined {
    return this.docs.get(uri)?.text;
  }

  /** Get the version of a document (0 if unknown). */
  getVersion(uri: string): number {
    return this.docs.get(uri)?.version ?? 0;
  }

  /** Get all open document URIs. */
  getUris(): string[] {
    return Array.from(this.docs.keys());
  }

  /** Check whether a document is currently open. */
  has(uri: string): boolean {
    return this.docs.has(uri);
  }

  /** Load files from disk (CLI mode). Converts paths to file:// URIs. */
  loadFromDisk(paths: string[]): void {
    for (const filePath of paths) {
      try {
        const text = readFileSync(filePath, 'utf-8');
        const uri = pathToFileURL(filePath).href;
        this.open(uri, text);
      } catch {
        // Skip unreadable files
      }
    }
  }
}
