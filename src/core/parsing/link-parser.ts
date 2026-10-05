import type { Range } from '../types.js';
import { buildLineStarts, offsetToPosition, parseMacros } from './macro-parser.js';
import { ArgType, lexArguments } from './argument-lexer.js';

export interface PassageRef {
  name: string;
  range: Range;
  source: 'link' | 'macro';
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

  let i = text.indexOf('[[');
  while (i !== -1) {
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
): PassageRef | undefined {
  const { line, character } = position;
  return [...parseLinks(text), ...parseMacroPassageRefs(text)].find(({ range: { start, end } }) =>
    (line > start.line || (line === start.line && character >= start.character)) &&
    (line < end.line || (line === end.line && character <= end.character)));
}

// ---------------------------------------------------------------------------
// Passage references in macro arguments
// ---------------------------------------------------------------------------

/** A statically resolved passage name and its offsets within the arguments. */
interface ArgTarget {
  name: string;
  start: number;
  end: number;
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
function resolveExpressionTarget(args: string): ArgTarget | null {
  const lead = args.length - args.trimStart().length;
  const expr = args.trim();
  if (expr === '') return null;

  const lexed = lexArguments(expr);
  if (lexed.length === 1 && lexed[0].start === 0 && lexed[0].end === expr.length &&
    (lexed[0].type === ArgType.String || lexed[0].type === ArgType.Expression)) {
    const raw = expr.slice(1, -1);
    if (interpolationRegex.test(raw) || raw.includes('${')) return null;
    return { name: raw.replace(/\\(.)/g, '$1'), start: lead + 1, end: lead + expr.length - 1 };
  }

  if (/[$@%"'`(]/.test(expr) || temporaryRefRegex.test(expr)) return null;
  if (EXPRESSION_BUILTINS.has(expr)) return null;
  return { name: expr, start: lead, end: lead + expr.length };
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
    name: target.name,
    start: target.start < cut ? target.start : target.start + width,
    end: target.end <= cut ? target.end : target.end + width,
  };
}

/**
 * `{link "label" "Passage"}` navigates to its second quoted string
 * (Spindle's MacroLink collects the quoted strings in order).
 */
function resolveLinkMacroTarget(args: string): ArgTarget | null {
  const strings = lexArguments(args).filter(a => a.type === ArgType.String);
  if (strings.length < 2) return null;
  const target = strings[1];
  const name = target.text.slice(1, -1);
  if (name.includes('\\') || interpolationRegex.test(name)) return null;
  return { name, start: target.start + 1, end: target.end - 1 };
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
    });
  }

  return refs;
}
