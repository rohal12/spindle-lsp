import {
  pairMarkup,
  parseSelectors,
  pieceOffset,
  tokenizeMarkupTolerant,
  type MacroToken,
  type MarkupError,
  type PairedNode,
  type Token,
} from '@rohal12/spindle/tooling';
import { PassageMarkup } from '../core/markup/passage-markup.js';
import { walkNodes } from '../core/markup/tree.js';
import { positionToOffset } from '../core/text.js';
import type { Passage, Position } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';

/**
 * The markup around a cursor, for the features that act on half-typed text
 * (completion, signature help). Every decision is made from the tooling
 * API's tokens, errors and pairing of the cursor's passage; a macro that is
 * still being typed is recovered from the offsets of the `MarkupError` the
 * tolerant tokenizer reports for it.
 */

/** A run of markup the tokenizer read as one: the passage itself, or a label or attribute value that holds markup of its own. */
export interface Region {
  /** The span of the passage `content` the region covers (inclusive at both ends). */
  start: number;
  end: number;
  /** Whether it is markup in text mode (a label, an attribute value). */
  text: boolean;
  tokens: readonly Token[];
  errors: readonly MarkupError[];
  /** The tree its tokens pair into. */
  nodes(): PairedNode[];
}

/** A macro being called: its name, and the arguments written before the cursor. */
export interface EnclosingMacro {
  name: string;
  argsBefore: string;
}

/** A macro name (`{na`) or a closer (`{/na`) being typed. */
export interface HeadBeingTyped {
  closing: boolean;
  /** The name typed so far. */
  typed: string;
  /** Offset of the `{`. */
  brace: number;
}

/** The passage that contains `position`, and the offset of `position` in its `content`. */
export function markupAt(workspace: WorkspaceModel, uri: string, position: Position): MarkupCursor | undefined {
  const doc = workspace.markup.get(uri);
  if (!doc || position.line >= doc.lineStarts.length) return undefined;
  let passage = doc.passageAt(position);
  // Text before the first header belongs to no passage; a user typing a new file still gets help there
  if (!passage) {
    const first = doc.passages[0];
    const end = first ? doc.lineStarts[first.passage.range.start.line] : doc.text.length;
    passage = new PassageMarkup(doc, preludePassage(uri), 0, end);
  }
  const offset = positionToOffset(position, doc.lineStarts);
  // The cursor is on the header line, before the body
  if (offset < passage.bodyStart) return undefined;
  const lineEnd = (doc.lineStarts[position.line + 1] ?? doc.text.length + 1) - 1;
  return new MarkupCursor(passage, passage.contentOffset(Math.min(offset, lineEnd)), workspace);
}

function preludePassage(uri: string): Passage {
  const origin = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  return { name: '', uri, range: origin, headerEnd: origin, nameRange: origin };
}

export class MarkupCursor {
  readonly content: string;
  private cachedRegions?: Region[];

  constructor(
    readonly passage: PassageMarkup,
    /** The cursor, as an offset into `passage.content`. */
    readonly at: number,
    private readonly workspace: WorkspaceModel,
  ) {
    this.content = passage.content;
  }

  /** The text of the cursor's line before the cursor. */
  get lineBefore(): string {
    return this.content.slice(this.content.lastIndexOf('\n', this.at - 1) + 1, this.at);
  }

  /** The runs of markup that contain the cursor, innermost first. */
  get regions(): Region[] {
    if (this.cachedRegions) return this.cachedRegions;
    const { passage, content } = this;
    const regions: Region[] = [{
      start: 0,
      end: content.length,
      text: false,
      tokens: passage.tokens,
      errors: passage.tokenization.errors,
      nodes: () => passage.pairing.nodes,
    }];
    for (const piece of passage.pieces) {
      if (piece.kind !== 'text') continue;
      const end = pieceOffset(piece, piece.text.length);
      if (piece.offset > this.at || this.at > end) continue;
      regions.push({
        start: piece.offset,
        end,
        text: true,
        tokens: piece.tokens,
        errors: piece.errors,
        nodes: () => pairMarkup(piece.tokens, { isBlock: name => this.workspace.isContainer(name), source: content }).nodes,
      });
    }
    return (this.cachedRegions = regions.reverse());
  }

  /**
   * The innermost macro whose arguments the cursor is in and that `known`
   * accepts. A macro still being typed has no token: it is the macro of an
   * `unclosed-macro` error, whose `offset` is its `{` and whose `end` the end
   * of its name.
   */
  enclosingMacro(known: (name: string) => boolean): EnclosingMacro | undefined {
    const { content, at } = this;
    for (const region of this.regions) {
      const found: Array<EnclosingMacro & { start: number }> = [];
      for (const token of region.tokens) {
        if (token.type !== 'macro' || token.isClose || token.nameEnd >= at || at >= token.end) continue;
        found.push({ start: token.start, name: token.name, argsBefore: at >= token.argsStart ? content.slice(token.argsStart, at) : '' });
      }
      for (const error of region.errors) {
        if (error.code !== 'unclosed-macro' || error.offset >= at || error.end >= at || !/\s/.test(content[error.end] ?? '')) continue;
        const name = content.slice(parseSelectors(content, error.offset + 1).end, error.end);
        if (name && name[0] !== '/') found.push({ start: error.offset, name, argsBefore: content.slice(error.end, at).trimStart() });
      }
      const innermost = found.filter(macro => known(macro.name)).sort((a, b) => b.start - a.start)[0];
      if (innermost) return { name: innermost.name, argsBefore: innermost.argsBefore };
    }
    return undefined;
  }

  /**
   * The macro name or closer being typed at the cursor (`{`, `{na`, `{/`),
   * or being renamed (the cursor on the name of a complete tag). The text
   * before the cursor says what is typed; the tokens say whether the `{` is
   * markup: not the escaped `\{`, not part of a comment, a string in a
   * macro's arguments or a `{do}` body.
   */
  headBeingTyped(): HeadBeingTyped | undefined {
    const { at } = this;
    const typedHead = /\{(\/?)([\w-]*)$/.exec(this.lineBefore);
    if (!typedHead) return undefined;
    const brace = at - typedHead[0].length;
    const closing = typedHead[1] === '/';
    const region = this.regions[0];
    if (brace < region.start) return undefined;
    const holder = region.tokens.find(token => token.start <= brace && brace < token.end);
    if (!holder) return undefined;
    if (holder.type === 'text') {
      const escaped = holder.start === brace - 1 && holder.end === brace + 1;
      if (holder.comment || escaped) return undefined;
    } else if (!(holder.type === 'macro' && holder.start === brace && holder.isClose === closing && holder.nameStart <= at && at <= holder.nameEnd)) {
      return undefined;
    }
    const inCode = this.passage.pieces.some(piece => piece.kind === 'code' && piece.offset <= brace && at <= piece.offset + piece.code.length);
    return inCode ? undefined : { closing, typed: typedHead[2], brace };
  }

  /** The block macros left open at `offset` in the innermost run of markup, innermost first. */
  openBlocks(offset: number): MacroToken[] {
    const open: MacroToken[] = [];
    for (const node of walkNodes(this.regions[0].nodes())) {
      if (node.token.type !== 'macro' || !node.body) continue;
      const { close } = node.body;
      if (node.token.start < offset && (!close || close.start >= offset)) open.push(node.token);
    }
    return open.sort((a, b) => b.start - a.start);
  }

  /**
   * Where the passage name of the bracket link at the cursor is written, or
   * undefined when the cursor is not in a link target. A link still being
   * typed (`[[go|Ta`) is read as the link that closing it would make.
   */
  linkTarget(): { start: number; end: number } | undefined {
    const { content, at } = this;
    const region = this.regions[0];
    if (region.text) return undefined;
    const link = region.tokens.find(token => token.type === 'link' && token.start < at && at < token.end);
    if (link?.type === 'link') {
      return link.targetStart <= at && at <= link.targetEnd ? { start: link.targetStart, end: link.targetEnd } : undefined;
    }
    const unclosed = region.errors.filter(error => error.code === 'unclosed-link' && error.offset + 2 <= at).pop();
    if (!unclosed) return undefined;
    const probe = tokenizeMarkupTolerant(`${content.slice(unclosed.offset, at)}]]`).tokens[0];
    if (probe?.type !== 'link' || probe.start !== 0 || probe.targetEnd + 2 !== probe.end) return undefined;
    return { start: unclosed.offset + probe.targetStart, end: at };
  }
}
