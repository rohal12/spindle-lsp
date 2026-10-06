import type { Range } from '../types.js';
import { buildLineStarts, offsetToPosition, maskRawDoBodies, parseMacros } from './macro-parser.js';
import { ArgType, lexArguments } from './argument-lexer.js';
import { attributeValueSpans } from './html-scanner.js';
import { createCodeScanner, type BraceReading } from './code-scanner.js';
import { HAS_PASSAGE_HEADER, maskNonMarkupPassages, passageBodies } from './passage-parser.js';
import { decodeStringLiteralBody, type JsQuote } from './js-string-literal.js';
import { bracketLinkMismatch, linkMacroStrings, readLinkMacroArgs, type LinkRead } from './link-runtime.js';

/**
 * Version-dependent link behavior (`SpindleCapabilities.linkQuoteEscapes`)
 * and brace reading (`stringAwareBraces`); Spindle 0.45.1 when omitted.
 */
export interface LinkRuntimeOptions extends BraceReading {
  linkQuoteEscapes?: boolean;
  /** Spindle >= 0.50.1: a `{do}` body is JavaScript text, so no reference is read from it. */
  rawDoBodies?: boolean;
  /** `SpindleCapabilities.includeInlineScoped`: how `{include}` finds its `inline` flag. */
  includeInlineScoped?: boolean;
}

/**
 * How a reference spells its target; rename re-encodes a new name per form.
 *  - `bracket`: the target of a `[[link]]`
 *  - `js-string`: a quoted `{goto}` / `{include}` target (a JavaScript string literal)
 *  - `bare`: an unquoted `{goto}` / `{include}` target (text fallback)
 *  - `link-string`: the quoted passage of `{link "label" "Passage"}`, which
 *    Spindle's MacroLink reads with a quote regex and does not unescape
 */
export type PassageRefForm = 'bracket' | 'js-string' | 'bare' | 'link-string';

export interface PassageRef {
  name: string;
  /** Source range of the target's spelling (inside any quotes). */
  range: Range;
  source: 'link' | 'macro';
  form: PassageRefForm;
  /** Delimiter of a quoted target. */
  quote?: JsQuote;
  /** The macro that reads a macro target (`goto`, `include` or `link`). */
  macro?: string;
}

/** The passage minimum needed to mask non-markup passages. */
type MaskablePassage = { name?: string; tags?: string[]; range: Range };

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

/**
 * Locate the target inside a link's inner text, mirroring Spindle's
 * `parseLink`: `display|target`, then `display->target`, then
 * `target<-display`, else the whole text. Returns offsets relative to
 * `inner`, with surrounding whitespace excluded.
 */
function locateTarget(inner: string): { start: number; end: number } {
  const [start, end] = splitLinkInner(inner).target;
  return { start, end };
}

/**
 * Split a link's inner text into its display and target spans (offsets
 * relative to `inner`, surrounding whitespace excluded), the way Spindle's
 * `parseLink` does: `display|target`, then `display->target`, then
 * `target<-display`, else the whole text for both.
 */
function splitLinkInner(inner: string): { display: [number, number]; target: [number, number] } {
  const trimmed = (from: number, to: number): [number, number] => {
    while (from < to && /\s/.test(inner[from])) from++;
    while (to > from && /\s/.test(inner[to - 1])) to--;
    return [from, to];
  };
  const pipe = inner.indexOf('|');
  const arrow = inner.indexOf('->');
  const reverse = inner.indexOf('<-');
  if (pipe !== -1) return { display: trimmed(0, pipe), target: trimmed(pipe + 1, inner.length) };
  if (arrow !== -1) return { display: trimmed(0, arrow), target: trimmed(arrow + 2, inner.length) };
  if (reverse !== -1) return { display: trimmed(reverse + 2, inner.length), target: trimmed(0, reverse) };
  const whole = trimmed(0, inner.length);
  return { display: whole, target: whole };
}

/**
 * Parse all passage references from bracket links in the given text.
 *
 * Follows Spindle's tokenizer: an optional `.class#id ` prefix after `[[`,
 * nested `[[...]]` inside the link, and the target forms
 *   [[PassageName]]
 *   [[Display Text|Target]]
 *   [[Display Text->Target]]
 *   [[Target<-Display Text]]
 *
 * @param text - the text to parse
 * @param lineOffset - optional line offset added to all line numbers (default 0)
 */
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
 * [start, end) source offsets: the only part of a link Spindle interpolates.
 * The tokenizer reads a link as one token and renders it as the `{link}`
 * macro; that macro is defined with `interpolate: true`, which makes the
 * macro wrapper (define-macro.ts) run its class and id through
 * interpolate(). The display and the target are not interpolated: MacroLink
 * prints and navigates to them as written, so `[[Take {$item}->T]]` renders
 * `Take {$item}` and everything else in the link is plain text (`{if $x}` or
 * `{goto "X"}` in a label execute nothing either). Verified on every release
 * from 0.43.0 by rendering the link (see docs/reviews/2026-10-06-convergence-fixes.md)
 * and by `link-interpolation.test.ts`.
 *
 * The tokenizer's own selector grammar admits interpolations of exactly the
 * form `{$name}`, `{_name}` and `{@name}` (with dot paths), so those are the
 * blocks there are.
 */
export function linkSelectorInterpolationRanges(text: string, link: BracketLink): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const selectors = text.slice(link.start + 2, link.innerStart);
  for (const m of selectors.matchAll(/\{[$_@]\w[\w.]*\}/g)) {
    ranges.push([link.start + 2 + m.index, link.start + 2 + m.index + m[0].length]);
  }
  return ranges;
}

/** Where a block the runtime prints literally was written. */
export type LiteralInterpolationPlace = 'link-label' | 'link-target' | 'link-macro-label' | 'link-macro-passage';

/** A `{$x}`-style block in link text, which Spindle's link macro prints as written. */
export interface LiteralLinkInterpolation {
  /** The block, braces included. */
  range: Range;
  /** The block's text, e.g. `{$item}`. */
  block: string;
  place: LiteralInterpolationPlace;
}

/** Options for {@link findLiteralLinkInterpolations}. */
export interface LiteralInterpolationOptions extends LinkRuntimeOptions {
  /** Spindle >= 0.50.1: braces inside strings are not counted when finding a block's end. */
  stringAwareBraces?: boolean;
}

/**
 * The `{$x}`, `{_x}`, `{@x}` and `{%x}` blocks (the ones interpolate() would
 * evaluate) in the display and target of the bracket links, and in the first
 * two strings of the `{link}` macros, of `text`. Spindle's link macro
 * interpolates none of them (see {@link linkSelectorInterpolationRanges}), so
 * each is rendered, or navigated to, with its braces. The same on every
 * release from 0.43.0.
 */
export function findLiteralLinkInterpolations(text: string, options: LiteralInterpolationOptions = {}): LiteralLinkInterpolation[] {
  const lineStarts = buildLineStarts(text);
  const found: LiteralLinkInterpolation[] = [];
  const stringAware = options.stringAwareBraces === true;
  const blocksIn = (from: number, to: number, place: LiteralInterpolationPlace) => {
    const part = text.slice(from, to);
    const scanner = stringAware ? createCodeScanner(part, { stringAwareBraces: true }) : undefined;
    for (let i = 0; i < part.length; i++) {
      if (part[i] !== '{' || !/^\{[$_@%]\w/.test(part.slice(i, i + 3))) continue;
      let close = -1;
      if (scanner) {
        close = scanner.closeBrace(i + 1);
      } else {
        let depth = 1;
        for (let j = i + 1; j < part.length; j++) {
          if (part[j] === '{') depth++;
          else if (part[j] === '}' && --depth === 0) {
            close = j;
            break;
          }
        }
      }
      if (close === -1) continue;
      found.push({
        range: { start: offsetToPosition(from + i, lineStarts), end: offsetToPosition(from + close + 1, lineStarts) },
        block: part.slice(i, close + 1),
        place,
      });
      i = close;
    }
  };

  const items: Array<{ at: number; run: () => void }> = [];
  for (const link of findBracketLinks(text, options)) {
    const parts = splitLinkInner(text.slice(link.innerStart, link.innerEnd));
    items.push({
      at: link.start,
      run: () => {
        blocksIn(link.innerStart + parts.display[0], link.innerStart + parts.display[1], 'link-label');
        // `[[x]]` reads its text as both display and target: one block, one finding
        if (parts.target[0] !== parts.display[0] || parts.target[1] !== parts.display[1]) {
          blocksIn(link.innerStart + parts.target[0], link.innerStart + parts.target[1], 'link-target');
        }
      },
    });
  }
  for (const macro of parseMacros(text, options)) {
    if (!macro.open || !macro.rawArgs || macro.name.toLowerCase() !== 'link') continue;
    const argsEnd = lineStarts[macro.range.end.line] + macro.range.end.character - 1;
    const argsStart = argsEnd - macro.rawArgs.length;
    const strings = linkMacroStrings(macro.rawArgs, options.linkQuoteEscapes === true).slice(0, 2);
    items.push({
      at: argsStart,
      run: () => strings.forEach((str, index) => {
        blocksIn(argsStart + str.start, argsStart + str.end, index === 0 ? 'link-macro-label' : 'link-macro-passage');
      }),
    });
  }
  for (const item of items.sort((x, y) => x.at - y.at)) item.run();
  return found;
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
 * link-runtime.ts), in order. Spindle >= 0.51.1 reads every link back.
 */
export function findLinkRuntimeMismatches(text: string, options: LinkRuntimeOptions = {}): LinkRuntimeMismatch[] {
  const escapes = options.linkQuoteEscapes === true;
  if (escapes) return [];
  const lineStarts = buildLineStarts(text);
  const found: LinkRuntimeMismatch[] = [];
  for (const link of findBracketLinks(text, options)) {
    const inner = text.slice(link.innerStart, link.innerEnd);
    const parts = splitLinkInner(inner);
    const display = inner.slice(...parts.display);
    const target = inner.slice(...parts.target);
    const runtime = bracketLinkMismatch(display, target, escapes);
    if (!runtime) continue;
    found.push({
      range: { start: offsetToPosition(link.start, lineStarts), end: offsetToPosition(link.end, lineStarts) },
      display,
      target,
      runtime,
    });
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
 * The `{link}` macros whose string arguments Spindle's link macro reads
 * differently from the JavaScript string literals they are written as: a
 * backslash escape before 0.51.1 (`{link "say \"hi\"" "T"}` navigates
 * nowhere), `\n` and the like (the macro decodes only quotes and
 * backslashes) in every version. Only macros whose arguments are all string
 * literals are compared; a variable argument has no value to compare.
 */
export function findLinkMacroMismatches(text: string, options: LinkRuntimeOptions = {}): LinkMacroMismatch[] {
  const escapes = options.linkQuoteEscapes === true;
  const lineStarts = buildLineStarts(text);
  const found: LinkMacroMismatch[] = [];
  for (const macro of parseMacros(text, options)) {
    if (!macro.open || !macro.rawArgs || macro.name.toLowerCase() !== 'link') continue;
    const argsEnd = lineStarts[macro.range.end.line] + macro.range.end.character - 1;
    const args = text.slice(argsEnd - macro.rawArgs.length, argsEnd);
    const lexed = lexArguments(args);
    if (lexed.length === 0 || lexed.some(arg => arg.type !== ArgType.String)) continue;
    const written: string[] = [];
    for (const arg of lexed.slice(0, 2)) {
      const quote = arg.text[0];
      if ((quote !== '"' && quote !== "'") || arg.text.length < 2 || arg.text.at(-1) !== quote) break;
      const value = decodeStringLiteralBody(arg.text.slice(1, -1), quote);
      if (value === null) break;
      written.push(value);
    }
    if (written.length !== Math.min(2, lexed.length)) continue;
    const display = written[0];
    const passage = written[1] ?? null;
    const runtime = readLinkMacroArgs(args, escapes);
    if (runtime.display === display && runtime.passage === passage) continue;
    found.push({ range: macro.range, display, passage, runtime });
  }
  return found;
}

export function parseLinks(text: string, lineOffset: number = 0, reading: BraceReading = {}): PassageRef[] {
  const lineStarts = buildLineStarts(text);
  const refs: PassageRef[] = [];

  for (const link of findBracketLinks(text, reading)) {
    const target = locateTarget(text.slice(link.innerStart, link.innerEnd));
    if (target.end <= target.start) continue;
    const nameStart = link.innerStart + target.start;
    const nameEnd = link.innerStart + target.end;
    const startPos = offsetToPosition(nameStart, lineStarts);
    const endPos = offsetToPosition(nameEnd, lineStarts);

    refs.push({
      name: text.slice(nameStart, nameEnd),
      range: {
        start: { line: startPos.line + lineOffset, character: startPos.character },
        end: { line: endPos.line + lineOffset, character: endPos.character },
      },
      source: 'link',
      form: 'bracket',
    });
  }

  return refs;
}

/**
 * Find the passage reference ([[link]] target or literal macro target)
 * whose range contains `position`.
 */
export function findPassageRefAt(
  text: string,
  position: { line: number; character: number },
  passages: MaskablePassage[] = [],
  options: LinkRuntimeOptions = {},
): PassageRef | undefined {
  const { line, character } = position;
  return parseDocumentPassageRefs(text, passages, options).find(({ range: { start, end } }) =>
    (line > start.line || (line === start.line && character >= start.character)) &&
    (line < end.line || (line === end.line && character <= end.character)));
}

/**
 * All executable passage references of a document: `[[links]]` and literal
 * macro targets, excluding the bodies of passages Spindle does not tokenize
 * as markup (script, stylesheet, StoryData, StoryVariables, ...), macro-argument strings
 * and HTML attribute values. This is the one extraction every navigation,
 * rename, link and diagnostic consumer shares.
 */
export function parseDocumentPassageRefs(
  text: string,
  passages: MaskablePassage[],
  options: LinkRuntimeOptions = {},
): PassageRef[] {
  const masked = maskNonMarkupPassages(text, passages);
  const markup = options.rawDoBodies ? maskRawDoBodies(masked, options) : masked;
  return [...parseLinks(markup, 0, options), ...parseMacroPassageRefs(markup, 0, options)];
}

// ---------------------------------------------------------------------------
// Passage references in macro arguments
// ---------------------------------------------------------------------------

/** A statically resolved passage name and its offsets within the arguments. */
interface ArgTarget {
  name: string;
  start: number;
  end: number;
  form: PassageRefForm;
  quote?: JsQuote;
}

/** Names Spindle's expression preamble binds; a bare one is not a passage name. */
const EXPRESSION_BUILTINS = new Set([
  'currentPassage', 'previousPassage', 'visited', 'hasVisited', 'hasVisitedAny',
  'hasVisitedAll', 'rendered', 'hasRendered', 'hasRenderedAny', 'hasRenderedAll',
  'random', 'randomInt',
]);

const interpolationRegex = /\{[$_@%][A-Za-z_$]/;
const temporaryRefRegex = /(?<![.\w$@%])_[A-Za-z_$][\w$]*(?![\w$])/;

/**
 * Resolve the passage name that `{goto}` / `{include}` compute from their
 * arguments: Spindle evaluates them as an expression and, when that throws,
 * uses the raw text with surrounding quotes stripped. A single string
 * literal therefore names its contents, and a bare name (a ReferenceError
 * or SyntaxError) names itself. Anything reading state or calling code is
 * dynamic and yields null.
 */
export function resolveExpressionTarget(args: string): ArgTarget | null {
  const lead = args.length - args.trimStart().length;
  const expr = args.trim();
  if (expr === '') return null;

  const lexed = lexArguments(expr);
  if (lexed.length === 1 && lexed[0].start === 0 && lexed[0].end === expr.length &&
    (lexed[0].type === ArgType.String || lexed[0].type === ArgType.Expression)) {
    const quote = expr[0];
    if ((quote !== '"' && quote !== "'" && quote !== '`') || expr.length < 2 || expr.at(-1) !== quote) return null;
    const raw = expr.slice(1, -1);
    if (interpolationRegex.test(raw) || (quote === '`' && raw.includes('${'))) return null;
    const name = decodeStringLiteralBody(raw, quote);
    if (name === null) return null;
    return { name, start: lead + 1, end: lead + expr.length - 1, form: 'js-string', quote };
  }

  if (/[$@%"'`(]/.test(expr) || temporaryRefRegex.test(expr)) return null;
  if (EXPRESSION_BUILTINS.has(expr)) return null;
  // Text made only of numbers and operators (`1 + 2`) evaluates to a value
  // (`3`); only a canonical number names itself. (Decided from the text, the
  // expression is never run.)
  if (/^[\s\d.+\-*/%&|^<>=!~]+$/.test(expr) && /\d/.test(expr) && String(Number(expr)) !== expr) return null;
  return { name: expr, start: lead, end: lead + expr.length, form: 'bare' };
}

/** Words that are not plain identifiers when evaluated: keywords, value literals, language and browser globals. */
const NON_NAME_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
  'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'let', 'static', 'await', 'async', 'of', 'undefined', 'NaN', 'Infinity', 'arguments', 'eval',
  'globalThis', 'window', 'self', 'top', 'parent', 'frames', 'document', 'location', 'history', 'navigator',
  'console', 'name', 'status', 'length', 'event', 'origin', 'screen', 'performance', 'localStorage', 'sessionStorage',
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Error',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Proxy', 'Reflect', 'Intl', 'Function',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'alert', 'confirm', 'prompt', 'fetch', 'setTimeout', 'setInterval',
]);

/**
 * True when `name` written bare as a `{goto}` / `{include}` argument is
 * certain to make Spindle's expression evaluation throw, so the runtime uses
 * the text itself. Decided from the text alone (nothing is evaluated).
 *
 * A single word is never certain: Spindle runs the argument as JavaScript, so
 * it may be a global or builtin (`URL`, `Image`, `Math`), one of the evaluator's
 * own parameters (`temporary`, `variables`, `locals`, `transient`) or its
 * preamble names, or a sigil name (`_x1` is `temporary["x1"]`, `$v`, `@l`, `%t`).
 * No list of those is complete, and quoting a name is always valid for these
 * macros, so a single word is quoted. Several words separated by single spaces
 * (`New Name`, `Chapter 2`) are a SyntaxError whatever the words are, unless one
 * is an operator or keyword (`in`, `typeof`, `new`, ...), which is excluded:
 * every word starts with a letter or digit, contains only letters, digits and
 * `_`, and the first starts with a letter. Anything else (`1 + 2`, `a-b`, `5`,
 * `_x 1`) may evaluate to another value and must be quoted.
 */
export function isVerbatimBareName(name: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_]*(?: [A-Za-z0-9][A-Za-z0-9_]*)+$/.test(name)) return false;
  return name.split(' ').every(word => !NON_NAME_WORDS.has(word) && !EXPRESSION_BUILTINS.has(word));
}

/**
 * `{include}` removes its `inline` flag from the arguments, then resolves the
 * rest like `{goto}`. Before Spindle 0.51.1 the first `inline` word anywhere
 * is removed (even inside a quoted target); from 0.51.1 only a standalone
 * word at the start or end, outside quotes and brackets, is the flag.
 */
function resolveIncludeTarget(args: string, options: LinkRuntimeOptions = {}): ArgTarget | null {
  if (options.includeInlineScoped) {
    const { start, end } = includeExpressionSpan(args);
    const target = resolveExpressionTarget(args.slice(start, end));
    return target && { ...target, start: target.start + start, end: target.end + start };
  }
  const inline = /\binline\b/.exec(args);
  if (!inline) return resolveExpressionTarget(args);

  const cut = inline.index;
  const width = inline[0].length;
  const target = resolveExpressionTarget(args.slice(0, cut) + args.slice(cut + width));
  if (!target || (target.start < cut && cut < target.end)) return null;
  return {
    ...target,
    start: target.start < cut ? target.start : target.start + width,
    end: target.end <= cut ? target.end : target.end + width,
  };
}

/**
 * The expression `{include}` evaluates for its passage name: the arguments
 * minus the `inline` flag, as the release in `options` removes it (see
 * resolveIncludeTarget). For consumers that need the text, not source offsets.
 */
export function includeNameExpression(args: string, options: LinkRuntimeOptions = {}): string {
  if (options.includeInlineScoped) {
    const { start, end } = includeExpressionSpan(args);
    return args.slice(start, end);
  }
  return args.replace(/\binline\b/, '').trim();
}

/**
 * The part of `{include}` arguments that names the passage in Spindle 0.51.1
 * and later (`parseIncludeArgs`): the trimmed arguments minus a standalone
 * `inline` word at the end or start (outside quotes and brackets, separated
 * by whitespace, and not next to a binary operator).
 */
function includeExpressionSpan(args: string): { start: number; end: number } {
  const lead = args.length - args.trimStart().length;
  const trimmed = args.trim();
  let first: [number, number] | null = null;
  let last: [number, number] | null = null;
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') inString = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && /\s/.test(ch)) {
      let end = i + 1;
      while (end < trimmed.length && /\s/.test(trimmed[end])) end++;
      last = [i, end];
      first ??= last;
      i = end - 1;
    }
  }
  if (last && last[1] === trimmed.length - 'inline'.length && trimmed.endsWith('inline') &&
    !/[-+*/%&|^!=<>?:,.]$/.test(trimmed.slice(0, last[0]))) {
    return { start: lead, end: lead + last[0] };
  }
  if (first && first[0] === 'inline'.length && trimmed.startsWith('inline') &&
    !/^[-+*/%&|^=<>?:,.]/.test(trimmed.slice(first[1]))) {
    return { start: lead + first[1], end: lead + trimmed.length };
  }
  return { start: lead, end: lead + trimmed.length };
}

/**
 * `{link "label" "Passage"}` navigates to its second quoted string. Spindle's
 * MacroLink collects the strings with a quote regex over the raw arguments
 * (see link-runtime.ts): before 0.51.1 no escape is decoded, so a backslash
 * is part of the name and a name cannot contain its own delimiter or a line
 * break; from 0.51.1 `\"`, `\'` and `\\` are decoded. The arguments are not
 * interpolated, so `{$x}` in the name is part of the passage name.
 */
export function resolveLinkMacroTarget(args: string, options: LinkRuntimeOptions = {}): ArgTarget | null {
  const second = linkMacroStrings(args, options.linkQuoteEscapes === true)[1];
  if (!second) return null;
  return { name: second.text, start: second.start, end: second.end, form: 'link-string', quote: second.quote };
}

const macroTargetResolvers: Record<string, (args: string, options: LinkRuntimeOptions) => ArgTarget | null> = {
  goto: args => resolveExpressionTarget(args),
  include: resolveIncludeTarget,
  link: resolveLinkMacroTarget,
};

/**
 * Parse all literal passage references in macro arguments:
 *   {goto "Passage"}  {goto 'Passage'}  {goto Passage}
 *   {include "Passage"}  {include Passage inline}
 *   {link "label" "Passage"}
 * including CSS-prefixed calls such as {.cls#id goto "Passage"}.
 * Dynamic targets (variables, expressions, interpolation) are skipped.
 *
 * @param text - the text to parse
 * @param lineOffset - optional line offset added to all line numbers (default 0)
 */
export function parseMacroPassageRefs(text: string, lineOffset: number = 0, options: LinkRuntimeOptions = {}): PassageRef[] {
  const lineStarts = buildLineStarts(text);
  const refs: PassageRef[] = [];

  for (const macro of parseMacros(text, options)) {
    if (!macro.open || !macro.rawArgs) continue;
    const resolve = macroTargetResolvers[macro.name.toLowerCase()];
    if (!resolve) continue;

    // rawArgs ends right before the closing brace. Read the arguments from
    // the source text, since parseMacros blanks {$var} interpolations.
    const argsEnd = lineStarts[macro.range.end.line] + macro.range.end.character - 1;
    const argsStart = argsEnd - macro.rawArgs.length;
    const target = resolve(text.slice(argsStart, argsEnd), options);
    if (!target || target.name === '') continue;

    const startPos = offsetToPosition(argsStart + target.start, lineStarts);
    const endPos = offsetToPosition(argsStart + target.end, lineStarts);
    refs.push({
      name: target.name,
      range: {
        start: { line: startPos.line + lineOffset, character: startPos.character },
        end: { line: endPos.line + lineOffset, character: endPos.character },
      },
      source: 'macro',
      form: target.form,
      quote: target.quote,
      macro: macro.name.toLowerCase(),
    });
  }

  return refs;
}
