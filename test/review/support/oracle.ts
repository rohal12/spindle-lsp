/**
 * The installed Spindle runtime as oracle for the cross-consumer matrix.
 *
 * Everything here is derived from `tokenize` / `buildAST` / the link macro's
 * own `parseArgs` of node_modules/@rohal12/spindle, plus an independent
 * (deliberately naive) splitter for Twee passages that does not share code
 * with src/. Expressions are only evaluated when the whole argument is a
 * single string literal written by these tests.
 */
import { tokenize, type Token } from '../../../node_modules/@rohal12/spindle/src/markup/tokenizer.js';
import { runtimeBracketLink, runtimeLinkMacro } from '../../helpers/link-macro-oracle.js';

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

/** A leading byte order mark is encoding, not text: the compiler reads the header behind it. */
const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** Passages of a Twee document: a header is a line starting with `::`. */
export function splitPassages(source: string): OraclePassage[] {
  const text = stripBom(source);
  const out: OraclePassage[] = [];
  const re = /(^|\n)(::[^\n]*)/g;
  const heads: Array<{ start: number; end: number; line: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length;
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

export interface OracleToken { token: Token; start: number; end: number; passage: OraclePassage }

/** Runtime tokens of every markup passage, with offsets mapped back to the (possibly CRLF) document. */
export function runtimeTokens(source: string): OracleToken[] {
  const text = stripBom(source);
  const out: OracleToken[] = [];
  for (const passage of splitPassages(text)) {
    if (!passage.markup || passage.bodyEnd <= passage.bodyStart) continue;
    const body = text.slice(passage.bodyStart, passage.bodyEnd);
    // Spindle's compiler normalizes CRLF to LF; map LF offsets back
    const lf = body.replace(/\r\n/g, '\n');
    // offsets in the LF text -> offsets in the document (each CRLF became one LF)
    const toDoc: number[] = [];
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '\r' && body[i + 1] === '\n') continue;
      toDoc.push(i);
    }
    toDoc.push(body.length);
    const map = (off: number) => toDoc[off] ?? body.length;
    for (const token of tokenize(lf)) {
      out.push({ token, start: passage.bodyStart + map(token.start), end: passage.bodyStart + map(token.end), passage });
    }
  }
  return out;
}

const SINGLE_LITERAL = /^\s*(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`$\\]|\\[^$])*`)\s*$/;
/** The value of an expression that is exactly one string literal, else null (dynamic). */
export function staticString(expr: string): string | null {
  if (!SINGLE_LITERAL.test(expr)) return null;
  try {
    const v: unknown = new Function(`return (${expr});`)();
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * What `{goto}` / `{include}` navigate to, per the runtime's own rule
 * (components/macros/Goto.tsx): evaluate the arguments, and when that throws
 * use the raw text with surrounding quotes stripped. Only two shapes are
 * resolvable without the story's state, and only those are evaluated here:
 * a single string literal, and a bare name made of word characters, spaces
 * and hyphens (a ReferenceError/SyntaxError, so the name itself). Anything
 * else (concatenation, parentheses, calls, sigils) is dynamic by design.
 */
export function gotoTarget(rawArgs: string, include = false): string | null {
  let args = rawArgs;
  if (include) args = args.replace(/\binline\b/, ' ');
  const literal = staticString(args);
  if (literal !== null) return literal;
  const bare = args.trim();
  if (!/^[A-Za-z_][\w -]*$/.test(bare)) return null;
  try {
    new Function(`return (${bare});`)();
    return null; // evaluates: a value, not a name
  } catch {
    return bare.replace(/^["']|["']$/g, '');
  }
}

export interface OracleRef {
  /** The passage the installed runtime navigates to (what a click does). */
  target: string;
  /** The passage the author wrote (the JavaScript meaning of the literal). */
  intended: string | null;
  /** Where the runtime's link macro actually navigates; differs from `intended` for literals it reads with its own rules. */
  reads: string | null;
  kind: 'bracket' | 'goto' | 'include' | 'link';
  start: number;
  end: number;
  uriText: string;
}

const LITERAL = String.raw`(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')`;
const TWO_LITERALS = new RegExp(`^\\s*${LITERAL}\\s+(${LITERAL})\\s*$`);


/** Passage targets the runtime resolves statically, per document text. */
export function runtimePassageRefs(source: string): OracleRef[] {
  const text = stripBom(source);
  const refs: OracleRef[] = [];
  for (const { token, start, end } of runtimeTokens(text)) {
    if (token.type === 'link') {
      const read = runtimeBracketLink(text.slice(start, end).replace(/\r\n/g, '\n'));
      // the link macro the bracket link becomes reads the target with its own rules (null: a click goes nowhere)
      refs.push({ target: token.target, intended: token.target, reads: read?.passage ?? null, kind: 'bracket', start, end, uriText: text });
    } else if (token.type === 'macro' && !token.isClose) {
      const name = token.name.toLowerCase();
      if (name === 'goto' || name === 'include') {
        const target = gotoTarget(token.rawArgs, name === 'include');
        if (target !== null) refs.push({ target, intended: target, reads: target, kind: name, start, end, uriText: text });
      } else if (name === 'link') {
        const read = runtimeLinkMacro(token.rawArgs);
        // `{link "label" "Passage"}`: the second literal names the passage (a single argument is a label only)
        const literal = TWO_LITERALS.exec(token.rawArgs)?.[1];
        if (literal !== undefined && read.passage) refs.push({ target: read.passage, intended: staticString(literal), reads: read.passage, kind: 'link', start, end, uriText: text });
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
export function runtimePayload(text: string): string[] {
  return runtimeTokens(text).flatMap(({ token }) => {
    if (token.type === 'macro') return [`m:${token.isClose ? '/' : ''}${token.name}:${token.rawArgs.replace(/\s+/g, ' ').trim()}`];
    if (token.type === 'link') return [`l:${token.target}`];
    if (token.type === 'variable') return [`v:${token.scope}:${token.name}`];
    return [];
  }).sort();
}
