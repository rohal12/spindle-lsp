/**
 * The installed Spindle runtime as oracle for the cross-consumer matrix.
 *
 * Everything here is derived from the public tooling API of
 * `@rohal12/spindle/tooling` (`tokenizeMarkupTolerant`,
 * `collectStoryPassageReferences`, `passageTarget`, `splitIncludeFlag`, ...),
 * plus an independent (deliberately naive) splitter for Twee passages that
 * does not share code with src/. Expressions are only evaluated by
 * `gotoTarget`, which the tests call with arguments written by themselves.
 */
import { collectStoryPassageReferences, splitIncludeFlag } from '@rohal12/spindle/tooling';
import { builtinMacros, deepTokens, normalizeEol, tokenize, type Token } from '../../helpers/tooling.js';
import { runtimeBracketLink } from '../../helpers/link-macro-oracle.js';
import { runtimeGotoTarget } from '../../helpers/expression-oracle.js';

export interface OraclePassage {
  name: string;
  tags: string[];
  /** Offset of the header line start / body start / body end in the document text. */
  headerStart: number;
  bodyStart: number;
  bodyEnd: number;
  markup: boolean;
}

const NON_MARKUP = new Set(['StoryTitle', 'StoryData', 'StoryVariables', 'StoryTransients', 'SaveTitle']);

/**
 * A leading byte order mark is encoding, not text: the compiler reads the
 * header behind it. It still occupies a UTF-16 unit of the client's buffer, so
 * every offset this oracle reports is an offset into the raw document text
 * (BOM included), never into a stripped copy.
 */
const bomLength = (text: string) => (text.charCodeAt(0) === 0xfeff ? 1 : 0);

/** Passages of a Twee document: a header is a line starting with `::` (behind the BOM on the first line). */
export function splitPassages(source: string): OraclePassage[] {
  const text = source;
  const out: OraclePassage[] = [];
  const re = /(^|\n)(::[^\n]*)/g;
  const heads: Array<{ start: number; end: number; line: string }> = [];
  const skip = bomLength(text);
  let m: RegExpExecArray | null;
  // matched on the text behind the BOM, then shifted back into raw coordinates
  const behind = text.slice(skip);
  while ((m = re.exec(behind))) {
    const start = skip + m.index + m[1].length;
    heads.push({ start, end: start + m[2].length, line: m[2].replace(/\r$/, '') });
  }
  heads.forEach((h, i) => {
    let rest = h.line.slice(2).trim();
    let tags: string[] = [];
    const tagMatch = /\s*\[([^\]]*)\]\s*(\{.*\})?$/.exec(rest);
    if (tagMatch && !rest.slice(0, tagMatch.index).endsWith('\\')) {
      tags = tagMatch[1].split(/\s+/).filter(Boolean);
      rest = rest.slice(0, tagMatch.index);
    }
    const name = rest.trim().replace(/\\(.)/g, '$1');
    const bodyStart = Math.min(h.end + 1, text.length);
    const bodyEnd = i + 1 < heads.length ? heads[i + 1].start : text.length;
    out.push({
      name, tags, headerStart: h.start, bodyStart, bodyEnd,
      markup: !NON_MARKUP.has(name) && !tags.includes('script') && !tags.includes('stylesheet'),
    });
  });
  return out;
}

/**
 * A token the runtime reads, with its span in the document. `nested` tokens are
 * those of markup inside a label or an attribute value (see `deepTokens`), so
 * they lie inside another token.
 */
export interface OracleToken { token: Token; start: number; end: number; passage: OraclePassage; nested: boolean }

/** Runtime tokens of every markup passage, with offsets mapped back to the (possibly CRLF) document. */
function runtimeTokensUncached(source: string): OracleToken[] {
  const text = source;
  const out: OracleToken[] = [];
  for (const passage of splitPassages(text)) {
    if (!passage.markup || passage.bodyEnd <= passage.bodyStart) continue;
    const body = text.slice(passage.bodyStart, passage.bodyEnd);
    // Spindle's compiler normalizes CRLF to LF; map LF offsets back
    const { lf, toOriginal: map } = normalizeEol(body);
    for (const { token, nested } of deepTokens(lf)) {
      out.push({ token, start: passage.bodyStart + map(token.start), end: passage.bodyStart + map(token.end), passage, nested });
    }
  }
  return out;
}

/**
 * Where `{goto}` / `{include}` navigate for these arguments, by the macros'
 * own rule (Spindle 0.59): `{include}`'s `inline` flag is split off with
 * `splitIncludeFlag`; the `passage` argument is read with `passageTarget`
 * (a string literal is the name, as JavaScript reads it), anything else is an
 * expression evaluated in the story's scopes (`evaluatePassageName`; the
 * tests pass the `_` scope as `temporary`). There is no text fallback: an
 * argument that does not evaluate (`{goto Old}`, a bare name that is no
 * variable) throws when the macro runs, and the macro navigates nowhere
 * (null). See test/helpers/expression-oracle.ts.
 */
export function gotoTarget(rawArgs: string, include = false, temporary: Record<string, unknown> = {}): string | null {
  const passage = include ? splitIncludeFlag(rawArgs).passage : rawArgs;
  if (passage === undefined) return null;
  return runtimeGotoTarget(passage, temporary);
}

export interface OracleRef {
  /** The passage the runtime navigates to (what a click does): the quoted name of the reference. */
  target: string;
  /** The passage the author wrote (the JavaScript meaning of the literal, or the link token's target). */
  intended: string | null;
  /**
   * Where the runtime actually navigates. For a bracket link the AST turns the
   * token into `{link "label" "target"}` and the macro reads the target with
   * `passageTarget`; null when that reads an expression (a target the
   * quoting cannot carry, e.g. a line break), so a click goes nowhere.
   */
  reads: string | null;
  /** `bracket` (`[[...]]`), or the macro that names the passage (`goto`, `include`, `link`, `watch`, `dialog`, ...). */
  kind: string;
  start: number;
  end: number;
  uriText: string;
}

/**
 * The enclosing top-level token of a reference: the span the consumers'
 * ranges are compared with (the reference itself may be a label or an
 * attribute value inside it).
 */
function enclosing(tokens: Token[], start: number, end: number): Token | undefined {
  return tokens.find(token => token.start <= start && end <= token.end);
}

/**
 * Passage targets the runtime resolves statically, per document text:
 * `collectStoryPassageReferences` against the built-in macros on each
 * passage (CRLF read as LF, offsets mapped back), keeping the references
 * whose target is a quoted name. A target that is an expression (`{goto $room}`,
 * and the bare names the 0.45.1 text fallback used to navigate by, `{goto Old}`)
 * names no passage until it runs and is not a static reference.
 */
function runtimePassageRefsUncached(source: string): OracleRef[] {
  const text = source;
  const refs: OracleRef[] = [];
  for (const passage of splitPassages(text)) {
    if (!passage.markup || passage.bodyEnd <= passage.bodyStart) continue;
    const body = text.slice(passage.bodyStart, passage.bodyEnd);
    const { lf, toOriginal } = normalizeEol(body);
    const tokens = tokenize(lf);
    for (const ref of collectStoryPassageReferences(lf, builtinMacros)) {
      if (ref.target.kind !== 'name') continue;
      const token = enclosing(tokens, ref.start, ref.end);
      const start = passage.bodyStart + toOriginal(token?.start ?? ref.start);
      const end = passage.bodyStart + toOriginal(token?.end ?? ref.end);
      const target = ref.target.name;
      if (ref.macro === 'link' && token?.type === 'link') {
        const read = runtimeBracketLink(lf.slice(token.start, token.end));
        refs.push({ target, intended: token.target, reads: read?.passage ?? null, kind: 'bracket', start, end, uriText: text });
      } else {
        refs.push({ target, intended: target, reads: target, kind: ref.macro, start, end, uriText: text });
      }
    }
  }
  return refs;
}

/** Macro heads (opening and closing) the runtime tokenizes in markup passages. */
export function runtimeMacroHeads(text: string): Array<{ name: string; isClose: boolean; start: number; end: number }> {
  return runtimeTokens(text).flatMap(({ token, start, end }) =>
    token.type === 'macro' ? [{ name: token.name, isClose: token.isClose, start, end }] : []);
}

/** Order-insensitive multiset of runtime macro (name, whitespace-normalized args). */
function runtimePayloadUncached(text: string): string[] {
  return runtimeTokens(text).flatMap(({ token }) => {
    if (token.type === 'macro') return [`m:${token.isClose ? '/' : ''}${token.name}:${token.rawArgs.replace(/\s+/g, ' ').trim()}`];
    if (token.type === 'link') return [`l:${token.target}`];
    if (token.type === 'variable') return [`v:${token.scope}:${token.name}`];
    return [];
  }).sort();
}

// ---------------------------------------------------------------------------
// The oracle is a pure function of the document text, and every property of a
// scene asks it about the same texts, so results are kept (bounded) per text.
// Callers get their own array: they sort and map freely.
// ---------------------------------------------------------------------------

function memo<T>(fn: (text: string) => T[]): (text: string) => T[] {
  const kept = new Map<string, T[]>();
  return text => {
    let hit = kept.get(text);
    if (hit === undefined) {
      hit = fn(text);
      kept.set(text, hit);
      if (kept.size > 400) kept.delete(kept.keys().next().value as string);
    }
    return hit.slice();
  };
}

export const runtimeTokens = memo(runtimeTokensUncached);
export const runtimePassageRefs = memo(runtimePassageRefsUncached);
export const runtimePayload = memo(runtimePayloadUncached);
