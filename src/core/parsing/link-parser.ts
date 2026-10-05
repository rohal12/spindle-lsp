import type { Range } from '../types.js';
import { buildLineStarts, offsetToPosition, parseMacros } from './macro-parser.js';
import { ArgType, lexArguments } from './argument-lexer.js';
import { attributeValueSpans } from './html-scanner.js';
import { isScriptOrStylesheetPassage } from './passage-parser.js';
import { decodeStringLiteralBody, type JsQuote } from './js-string-literal.js';

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
}

/** The passage minimum needed to mask code passages. */
type MaskablePassage = { tags?: string[]; range: Range };

/**
 * Replace the body of every script/stylesheet passage with spaces, keeping
 * line breaks so offsets and positions are unchanged. Those bodies hold
 * JS/CSS, not story markup, so they contain no links or macro targets.
 */
export function maskScriptAndStylesheetPassages(text: string, passages: MaskablePassage[]): string {
  const excluded = passages.filter(isScriptOrStylesheetPassage);
  if (excluded.length === 0) return text;

  const lines = text.split('\n');
  for (const passage of excluded) {
    const last = Math.min(passage.range.end.line, lines.length - 1);
    for (let i = passage.range.start.line + 1; i <= last; i++) {
      lines[i] = lines[i].replace(/[^\r]/g, ' ');
    }
  }
  return lines.join('\n');
}

/**
 * Offset spans where `[[` is literal text rather than a link: macro tags
 * (whose arguments Spindle's tokenizer consumes whole) and HTML attribute
 * values.
 */
function literalSpans(text: string, lineStarts: number[]): Array<[number, number]> {
  const spans: Array<[number, number]> = attributeValueSpans(text);
  if (text.includes('{')) {
    for (const macro of parseMacros(text)) {
      spans.push([
        lineStarts[macro.range.start.line] + macro.range.start.character,
        lineStarts[macro.range.end.line] + macro.range.end.character,
      ]);
    }
  }
  return spans.sort((a, b) => a[0] - b[0]);
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
  let start = 0;
  let end = inner.length;

  const pipeIdx = inner.indexOf('|');
  const arrowIdx = inner.indexOf('->');
  const revIdx = inner.indexOf('<-');
  if (pipeIdx !== -1) {
    start = pipeIdx + 1;
  } else if (arrowIdx !== -1) {
    start = arrowIdx + 2;
  } else if (revIdx !== -1) {
    end = revIdx;
  }

  while (start < end && /\s/.test(inner[start])) start++;
  while (end > start && /\s/.test(inner[end - 1])) end--;
  return { start, end };
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
export function parseLinks(text: string, lineOffset: number = 0): PassageRef[] {
  const lineStarts = buildLineStarts(text);
  const refs: PassageRef[] = [];
  const literals = text.includes('[[') ? literalSpans(text, lineStarts) : [];
  const inLiteral = (offset: number) => literals.some(([a, b]) => a <= offset && offset < b);

  let i = text.indexOf('[[');
  while (i !== -1) {
    if (inLiteral(i)) {
      i = text.indexOf('[[', i + 1);
      continue;
    }
    const linkStart = i;
    i += 2;
    if (text[i] === '.' || text[i] === '#') {
      i = skipSelectors(text, i);
      if (text[i] === ' ') i++;
    }

    // Find the closing ]], allowing nested [[...]]
    const innerStart = i;
    let depth = 1;
    while (i < text.length) {
      if (text.startsWith('[[', i)) {
        depth++;
        i += 2;
      } else if (text.startsWith(']]', i)) {
        if (--depth === 0) break;
        i += 2;
      } else {
        i++;
      }
    }

    if (depth !== 0) {
      // Unclosed link: Spindle treats it as text and rescans after `[[`
      i = text.indexOf('[[', linkStart + 2);
      continue;
    }

    const target = locateTarget(text.slice(innerStart, i));
    if (target.end > target.start) {
      const nameStart = innerStart + target.start;
      const nameEnd = innerStart + target.end;
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

    i = text.indexOf('[[', i + 2);
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
): PassageRef | undefined {
  const { line, character } = position;
  return parseDocumentPassageRefs(text, passages).find(({ range: { start, end } }) =>
    (line > start.line || (line === start.line && character >= start.character)) &&
    (line < end.line || (line === end.line && character <= end.character)));
}

/**
 * All executable passage references of a document: `[[links]]` and literal
 * macro targets, excluding script/stylesheet bodies, macro-argument strings
 * and HTML attribute values. This is the one extraction every navigation,
 * rename, link and diagnostic consumer shares.
 */
export function parseDocumentPassageRefs(text: string, passages: MaskablePassage[]): PassageRef[] {
  const markup = maskScriptAndStylesheetPassages(text, passages);
  return [...parseLinks(markup), ...parseMacroPassageRefs(markup)];
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
  return { name: expr, start: lead, end: lead + expr.length, form: 'bare' };
}

/**
 * `{include}` first removes one `inline` keyword from its arguments, then
 * resolves the rest like `{goto}`.
 */
function resolveIncludeTarget(args: string): ArgTarget | null {
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
 * `{link "label" "Passage"}` navigates to its second quoted string. Spindle's
 * MacroLink collects them with `/(["'])(.*?)\1/g` over the raw arguments:
 * no escape is decoded, so a backslash is part of the name and a name cannot
 * contain its own delimiter or a line break.
 */
export function resolveLinkMacroTarget(args: string): ArgTarget | null {
  const re = /(["'])(.*?)\1/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = re.exec(args)) !== null) {
    if (++index < 2) continue;
    const name = match[2];
    if (interpolationRegex.test(name)) return null;
    const start = match.index + 1;
    return { name, start, end: start + name.length, form: 'link-string', quote: match[1] as JsQuote };
  }
  return null;
}

const macroTargetResolvers: Record<string, (args: string) => ArgTarget | null> = {
  goto: resolveExpressionTarget,
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
export function parseMacroPassageRefs(text: string, lineOffset: number = 0): PassageRef[] {
  const lineStarts = buildLineStarts(text);
  const refs: PassageRef[] = [];

  for (const macro of parseMacros(text)) {
    if (!macro.open || !macro.rawArgs) continue;
    const resolve = macroTargetResolvers[macro.name.toLowerCase()];
    if (!resolve) continue;

    // rawArgs ends right before the closing brace. Read the arguments from
    // the source text, since parseMacros blanks {$var} interpolations.
    const argsEnd = lineStarts[macro.range.end.line] + macro.range.end.character - 1;
    const argsStart = argsEnd - macro.rawArgs.length;
    const target = resolve(text.slice(argsStart, argsEnd));
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
    });
  }

  return refs;
}
