import { builtinMacros, findCodeEnd, isBlockMacro, splitIncludeFlag } from '@rohal12/spindle/tooling';
import type { Passage, Range } from '../types.js';
import { buildLineStarts, parseMacros } from './macro-parser.js';
import { attributeValueSpans } from './html-scanner.js';
import type { BraceReading } from './code-scanner.js';
import { HAS_PASSAGE_HEADER, passageBodies } from './passage-parser.js';
import { bracketLinkMismatch, type LinkRead } from './link-runtime.js';
import { PassageIndex } from '../workspace/passage-index.js';
import { DocumentMarkup } from '../markup/passage-markup.js';
import { documentPassageRefs } from '../markup/passage-refs.js';

// ---------------------------------------------------------------------------
// Passage references (and the checks on them) in a text
//
// The reading of a passage's markup is the tooling API's (see
// core/markup/passage-refs.ts); these functions take a text rather than a
// workspace document, for the callers that have none (diagnostics, completion).
// ---------------------------------------------------------------------------

/** @deprecated No release-dependent behavior is left; `linkQuoteEscapes` is ignored. Delete with the callers that pass it. */
export interface LinkRuntimeOptions extends BraceReading {
  linkQuoteEscapes?: boolean;
}

const TEXT_URI = 'memory:///text.tw';
const TEXT_CONTEXT = { macros: builtinMacros, isBlock: isBlockMacro };

/**
 * The markup of `text`: a Twee document (its passages), or a bare body (one
 * passage without a header) when it declares none.
 */
function markupOfText(text: string): DocumentMarkup {
  if (lastMarkup?.text === text) return lastMarkup;
  const markup = readText(text);
  lastMarkup = markup;
  return markup;
}

/** The last text read: diagnostics asks about the same text several times. */
let lastMarkup: DocumentMarkup | undefined;

function readText(text: string): DocumentMarkup {
  const index = new PassageIndex();
  index.rebuild(TEXT_URI, text);
  let passages = index.getPassagesInDocument(TEXT_URI);
  if (passages.length === 0) {
    const nowhere: Range = { start: { line: -1, character: 0 }, end: { line: -1, character: 0 } };
    const body: Passage = {
      name: '',
      range: { start: { line: 0, character: 0 }, end: nowhere.end },
      headerEnd: nowhere,
      nameRange: nowhere,
      uri: TEXT_URI,
    };
    passages = [body];
  }
  return new DocumentMarkup(TEXT_URI, text, passages, TEXT_CONTEXT);
}

/** A bracket link's target. */
export interface LinkRef {
  name: string;
  /** The target as written. */
  range: Range;
  source: 'link';
}

/**
 * The targets of the bracket links of `text`, in order: `[[Target]]`,
 * `[[Display|Target]]`, `[[Display->Target]]`, `[[Target<-Display]]`, after
 * the optional `.class#id` prefix. A link with an empty target has none.
 *
 * @param text - a Twee document, or the body of one passage
 * @param lineOffset - added to every line number (default 0)
 */
export function parseLinks(text: string, lineOffset: number = 0, _reading?: LinkRuntimeOptions): LinkRef[] {
  if (!text.includes('[[')) return [];
  return documentPassageRefs(markupOfText(text))
    .filter(ref => ref.form === 'bracket')
    .map(ref => ({
      name: ref.name,
      range: {
        start: { line: ref.range.start.line + lineOffset, character: ref.range.start.character },
        end: { line: ref.range.end.line + lineOffset, character: ref.range.end.character },
      },
      source: 'link' as const,
    }));
}

/**
 * The expression `{include}` evaluates for its passage name: the arguments
 * minus the `inline` flag (`splitIncludeFlag`).
 */
export function includeNameExpression(args: string, _options?: LinkRuntimeOptions): string {
  return splitIncludeFlag(args).passage ?? '';
}

/** A bracket link whose runtime navigation differs from its source. */
export interface LinkRuntimeMismatch {
  /** The whole `[[...]]` link. */
  range: Range;
  /** Display text and target as the source says (the tokenizer's reading). */
  display: string;
  target: string;
  /** What Spindle's link macro reads instead. */
  runtime: LinkRead;
}

/**
 * The bracket links Spindle's link macro does not read back as written (see
 * link-runtime.ts), in order: a target with a line break, which the macro's
 * quoted target cannot carry.
 */
export function findLinkRuntimeMismatches(text: string, _options?: LinkRuntimeOptions): LinkRuntimeMismatch[] {
  if (!text.includes('[[')) return [];
  const found: LinkRuntimeMismatch[] = [];
  for (const ref of documentPassageRefs(markupOfText(text))) {
    if (ref.form !== 'bracket') continue;
    const link = ref.passage.tokens.find(token => token.type === 'link' && token.targetStart === ref.start);
    if (link?.type !== 'link') continue;
    const runtime = bracketLinkMismatch(link.display, link.target);
    if (!runtime) continue;
    found.push({ range: ref.passage.range(link.start, link.end), display: link.display, target: link.target, runtime });
  }
  return found;
}

/** A `{link "label" "Passage"}` whose runtime reading differs from its string literals. */
export interface LinkMacroMismatch {
  /** The macro tag. */
  range: Range;
  /** The label and passage the two string literals say. */
  display: string;
  passage: string | null;
  /** What Spindle's link macro reads instead. */
  runtime: LinkRead;
}

/**
 * The `{link}` macros whose strings the macro reads differently from their
 * JavaScript meaning. The macro reads its `passage` argument as a JavaScript
 * string literal (`passageTarget`), so there are none.
 * @deprecated Always empty; delete with its caller.
 */
export function findLinkMacroMismatches(_text: string, _options?: LinkRuntimeOptions): LinkMacroMismatch[] {
  return [];
}

/** Where a block the runtime takes as part of a passage name was written. */
export type LiteralInterpolationPlace = 'link-target' | 'link-macro-passage';

/** A `{$x}`-style block in the target of a link, which is part of the passage name. */
export interface LiteralLinkInterpolation {
  /** The block, braces included. */
  range: Range;
  /** The block's text, e.g. `{$item}`. */
  block: string;
  place: LiteralInterpolationPlace;
}

/** Options for {@link findLiteralLinkInterpolations}. */
export interface LiteralInterpolationOptions extends LinkRuntimeOptions {
  /** @deprecated Always on. */
  stringAwareBraces?: boolean;
}

/**
 * The `{$x}`, `{_x}`, `{@x}` and `{%x}` blocks in the passage name of a
 * bracket link or of a `{link}` macro. The name is read as written (a bracket
 * target as text, a `{link}` passage as a JavaScript string), so a block in it
 * is part of the name a click navigates to. The label of a link is markup and
 * is interpolated.
 */
export function findLiteralLinkInterpolations(text: string, _options?: LiteralInterpolationOptions): LiteralLinkInterpolation[] {
  const found: LiteralLinkInterpolation[] = [];
  for (const ref of documentPassageRefs(markupOfText(text))) {
    if (ref.macro !== 'link' || ref.form === 'text') continue;
    const written = ref.passage.content.slice(ref.start, ref.end);
    for (let i = 0; i < written.length; i++) {
      if (written[i] !== '{' || !/^\{[$_@%]\w/.test(written.slice(i, i + 3))) continue;
      const close = findCodeEnd(written, i + 1);
      if (close === -1) continue;
      found.push({
        range: ref.passage.range(ref.start + i, ref.start + close + 1),
        block: written.slice(i, close + 1),
        place: ref.form === 'bracket' ? 'link-target' : 'link-macro-passage',
      });
      i = close;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Bracket links as the old text scanner read them
//
// Still read by variable-tracker.ts (findBracketLinks, linkSelectorInterpolationRanges)
// and macro-parser.ts (bracketLinkEnd), which scan text with their own
// tokenizer mirror. Delete with them: the tooling API's link tokens
// (selectorsStart/End, displayStart/End, targetStart/End) replace all of it.
// ---------------------------------------------------------------------------

/**
 * Offset spans where `[[` is literal text rather than a link: macro tags
 * (whose arguments Spindle's tokenizer consumes whole) and HTML attribute
 * values.
 */
function literalSpans(text: string, lineStarts: number[], reading: BraceReading): Array<[number, number]> {
  const spans: Array<[number, number]> = attributeValueSpans(text, reading);
  if (text.includes('{')) {
    for (const macro of parseMacros(text, reading)) {
      spans.push([
        lineStarts[macro.range.start.line] + macro.range.start.character,
        lineStarts[macro.range.end.line] + macro.range.end.character,
      ]);
    }
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

/** Sorted spans merged into disjoint ones. */
function mergeSpans(spans: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
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

/** Offset of the `]]` closing a link whose inner text starts at `from`, or -1. */
function findLinkClose(text: string, from: number): number {
  let i = from;
  let depth = 1;
  while (i < text.length) {
    if (text.startsWith('[[', i)) {
      depth++;
      i += 2;
    } else if (text.startsWith(']]', i)) {
      if (--depth === 0) return i;
      i += 2;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * End offset (after the closing `]]`) of the complete bracket link opening
 * at `linkStart`, or -1 if the link never closes. Spindle's tokenizer reads
 * such a link as a single token, so nothing inside it is markup.
 */
export function bracketLinkEnd(text: string, linkStart: number): number {
  let i = linkStart + 2;
  if (text[i] === '.' || text[i] === '#') {
    i = skipSelectors(text, i);
    if (text[i] === ' ') i++;
  }
  const close = findLinkClose(text, i);
  return close === -1 ? -1 : close + 2;
}

/** A complete bracket link as Spindle's tokenizer reads it. */
export interface BracketLink {
  /** Offset of the opening `[[`. */
  start: number;
  /** Offset just past the closing `]]`. */
  end: number;
  /** Offset of the inner text (after `[[` and any `.class#id ` prefix). */
  innerStart: number;
  /** Offset of the closing `]]`. */
  innerEnd: number;
}

/**
 * The complete bracket links of a text, in order: the tokens Spindle's
 * tokenizer reads as links. Nothing inside a link is markup. A `[[` inside a
 * macro tag or an HTML attribute value starts no link, and one that never
 * closes is text (the scan resumes right after its `[[`).
 */
export function findBracketLinks(text: string, reading: BraceReading = {}): BracketLink[] {
  // Spindle renders each passage on its own: a link never spans a header
  if (!HAS_PASSAGE_HEADER.test(text)) return findBracketLinksInPassage(text, reading);
  return passageBodies(text).flatMap(body =>
    findBracketLinksInPassage(text.slice(body.start, body.end), reading).map(link => ({
      start: link.start + body.start,
      end: link.end + body.start,
      innerStart: link.innerStart + body.start,
      innerEnd: link.innerEnd + body.start,
    })));
}

function findBracketLinksInPassage(text: string, reading: BraceReading): BracketLink[] {
  const links: BracketLink[] = [];
  if (!text.includes('[[')) return links;
  const literals = mergeSpans(literalSpans(text, buildLineStarts(text), reading));
  let literal = 0;
  const inLiteral = (offset: number) => {
    while (literal < literals.length && literals[literal][1] <= offset) literal++;
    return literal < literals.length && literals[literal][0] <= offset;
  };

  let i = text.indexOf('[[');
  while (i !== -1) {
    if (inLiteral(i)) {
      i = text.indexOf('[[', i + 1);
      continue;
    }
    const start = i;
    i += 2;
    if (text[i] === '.' || text[i] === '#') {
      i = skipSelectors(text, i);
      if (text[i] === ' ') i++;
    }
    const innerStart = i;
    const close = findLinkClose(text, innerStart);
    if (close === -1) {
      // Unclosed link: Spindle treats it as text and rescans after `[[`
      i = text.indexOf('[[', start + 2);
      continue;
    }
    links.push({ start, end: close + 2, innerStart, innerEnd: close });
    i = text.indexOf('[[', close + 2);
  }
  return links;
}

/**
 * The `{$x}`-style blocks in a bracket link's `.class#id` selectors, as sorted
 * [start, end) source offsets: the only part of a link's text that is not
 * markup of its own is interpolated by the link macro (its label is markup
 * too, see `passagePieces`). The tokenizer's own selector grammar admits
 * interpolations of exactly the form `{$name}`, `{_name}` and `{@name}` (with
 * dot paths), so those are the blocks there are.
 */
export function linkSelectorInterpolationRanges(text: string, link: BracketLink): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const selectors = text.slice(link.start + 2, link.innerStart);
  for (const m of selectors.matchAll(/\{[$_@]\w[\w.]*\}/g)) {
    ranges.push([link.start + 2 + m.index, link.start + 2 + m.index + m[0].length]);
  }
  return ranges;
}
