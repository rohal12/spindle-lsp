import { builtinMacros, findCodeEnd, isBlockMacro } from '@rohal12/spindle/tooling';
import type { Passage, Range } from '../types.js';
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
export function findLinkRuntimeMismatches(text: string): LinkRuntimeMismatch[] {
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

/**
 * The `{$x}`, `{_x}`, `{@x}` and `{%x}` blocks in the passage name of a
 * bracket link or of a `{link}` macro. The name is read as written (a bracket
 * target as text, a `{link}` passage as a JavaScript string), so a block in it
 * is part of the name a click navigates to. The label of a link is markup and
 * is interpolated.
 */
export function findLiteralLinkInterpolations(text: string): LiteralLinkInterpolation[] {
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
