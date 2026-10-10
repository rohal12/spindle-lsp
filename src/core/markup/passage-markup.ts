import {
  pairMarkup,
  parseDeclarations,
  passagePieces,
  tokenizeMarkupTolerant,
  type Declaration,
  type DeclarationError,
  type MarkupError,
  type PairedNode,
  type PairingError,
  type Piece,
  type ToolingMacro,
  type Token,
} from '@rohal12/spindle/tooling';
import { isMarkupPassage } from '../parsing/passage-parser.js';
import { buildLineStarts, offsetsToRange, offsetToPosition } from '../text.js';
import type { Passage, Position, Range } from '../types.js';

/** What the tooling API needs to know about the project's macros. */
export interface MarkupContext {
  /** Every macro the markup may use: built-in, discovered, configured. */
  readonly macros: readonly ToolingMacro[];
  /** Whether `{name}` opens a block closed by `{/name}`: a block macro or a block widget. */
  isBlock(name: string): boolean;
}

/**
 * One passage's markup, read by Spindle's own tooling API.
 *
 * `content` is the passage body with its line breaks normalized to LF, as the
 * compiler hands it to the runtime. Every offset the tooling API reports is
 * an offset into `content` (UTF-16 code units); `docOffset()` and `range()`
 * map them back to the document, so CRLF documents need no special case in a
 * consumer.
 *
 * The analyses are computed on first use and kept.
 */
export class PassageMarkup {
  /** The body, LF-normalized: the text the tooling API analyzes. */
  readonly content: string;
  /** Whether Spindle reads the body as story markup (see isMarkupPassage). */
  readonly isMarkup: boolean;
  /** For each `content` offset, its offset in the document; null when the body has no CRLF. */
  private readonly toDoc: Int32Array | null;

  private cachedTokens?: { tokens: Token[]; errors: MarkupError[] };
  private cachedPairing?: { nodes: PairedNode[]; errors: PairingError[] };
  private cachedPieces?: Piece[];
  private cachedDeclarations?: { declarations: Declaration[]; errors: DeclarationError[] };

  constructor(
    readonly doc: DocumentMarkup,
    readonly passage: Passage,
    /** Offset in the document of the first character after the header line. */
    readonly bodyStart: number,
    /** Offset in the document where the body ends (the next header, or the end of the text). */
    readonly bodyEnd: number,
  ) {
    const raw = doc.text.slice(bodyStart, bodyEnd);
    this.isMarkup = isMarkupPassage(passage);
    if (raw.includes('\r\n')) {
      const map: number[] = [];
      let content = '';
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] === '\r' && raw[i + 1] === '\n') continue;
        map.push(bodyStart + i);
        content += raw[i];
      }
      map.push(bodyEnd);
      this.content = content;
      this.toDoc = Int32Array.from(map);
    } else {
      this.content = raw;
      this.toDoc = null;
    }
  }

  /** The document offset of `contentOffset`. */
  docOffset(contentOffset: number): number {
    if (!this.toDoc) return this.bodyStart + contentOffset;
    return this.toDoc[Math.min(Math.max(contentOffset, 0), this.toDoc.length - 1)];
  }

  /**
   * The document offset just past the character before `contentEnd`: where an
   * exclusive end maps to. (`docOffset()` of an end that sits before a line
   * break would land behind the `\r` of a CRLF.)
   */
  docEnd(contentEnd: number): number {
    return contentEnd <= 0 ? this.docOffset(0) : this.docOffset(contentEnd - 1) + 1;
  }

  /** The `content` offset of a document offset (the nearest one at or after it). */
  contentOffset(docOffset: number): number {
    if (!this.toDoc) return Math.min(Math.max(docOffset - this.bodyStart, 0), this.content.length);
    let low = 0;
    let high = this.toDoc.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.toDoc[mid] < docOffset) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  /** The document position of `contentOffset`. */
  position(contentOffset: number): Position {
    return offsetToPosition(this.docOffset(contentOffset), this.doc.lineStarts);
  }

  /** The document range of `[start, end)` in `content` offsets. */
  range(start: number, end: number): Range {
    return offsetsToRange(this.docOffset(start), end > start ? this.docEnd(end) : this.docOffset(start), this.doc.lineStarts);
  }

  /** The flat tokens and the malformed tags; none for a passage that is not markup. */
  get tokenization(): { tokens: Token[]; errors: MarkupError[] } {
    return (this.cachedTokens ??= this.isMarkup ? tokenizeMarkupTolerant(this.content) : { tokens: [], errors: [] });
  }

  get tokens(): Token[] {
    return this.tokenization.tokens;
  }

  /** The tree of paired tokens, and what does not pair. */
  get pairing(): { nodes: PairedNode[]; errors: PairingError[] } {
    return (this.cachedPairing ??= pairMarkup(this.tokens, {
      isBlock: (name) => this.doc.context.isBlock(name),
      source: this.content,
    }));
  }

  /** What the markup runs and names, and where (see `passagePieces`). */
  get pieces(): Piece[] {
    return (this.cachedPieces ??= this.isMarkup ? passagePieces(this.content, this.doc.context.macros) : []);
  }

  /** The declarations of a StoryVariables / StoryTransients passage. */
  get declarations(): { declarations: Declaration[]; errors: DeclarationError[] } {
    return (this.cachedDeclarations ??= parseDeclarations(this.content, this.passage.name === 'StoryTransients' ? '%' : '$'));
  }
}

/** The markup of every passage of one document. */
export class DocumentMarkup {
  readonly lineStarts: number[];
  readonly passages: PassageMarkup[];

  constructor(
    readonly uri: string,
    readonly text: string,
    passages: readonly Passage[],
    readonly context: MarkupContext,
  ) {
    this.lineStarts = buildLineStarts(text);
    this.passages = passages.map((passage, i) => {
      const bodyStart = this.lineStarts[passage.headerEnd.end.line + 1] ?? text.length;
      const next = passages[i + 1];
      const bodyEnd = next ? this.lineStarts[next.range.start.line] : text.length;
      return new PassageMarkup(this, passage, Math.min(bodyStart, bodyEnd), bodyEnd);
    });
  }

  /** The passage that contains `position`. */
  passageAt(position: Position): PassageMarkup | undefined {
    for (let i = this.passages.length - 1; i >= 0; i--) {
      if (this.passages[i].passage.range.start.line <= position.line) return this.passages[i];
    }
    return undefined;
  }
}
