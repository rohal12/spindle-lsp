/**
 * HTML elements and block macros share one stack in Spindle's pairing
 * (`pairMarkup`, which `parseMarkup` runs): `{wrap}<div>{/wrap}</div>` is
 * rejected at `{/wrap}` because a `<div>` is on top, not at the `</div>`.
 * This differential runs every sequence of up to N of `<div>`, `</div>`,
 * `{if}`, `{/if}`, `{wrap}` and `{/wrap}` (the first three and last three are
 * the element, a built-in block and a block widget) through the installed
 * runtime's tokenizer and pairing (public tooling API) and through every
 * consumer of the container structure:
 *
 *  - diagnostics (SP101 container, SP102 element, SP104 closer): none when
 *    the runtime accepts the passage; otherwise one at the tag the pairing
 *    reports first (or, for an unclosed node, at the innermost one);
 *  - folding ranges: the pairs `pairMarkup` makes, recovered ones included;
 *  - widget heads (references, definition, rename): an opener always; a
 *    closer when pairMarkup pops it, or when a container of its name is open
 *    (written out of order), but not a stray one.
 *
 * Tokens after the first error are never rendered, so nothing is asserted
 * about them.
 */
import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { isBlockMacro } from '@rohal12/spindle/tooling';
import { pair, tokenize, type Token } from '../helpers/tooling.js';
import { walkNodes } from '../../src/core/markup/tree.js';
import { runtimeMarkupFailure } from '../helpers/runtime-ast.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeFoldingRanges } from '../../src/plugins/folding-range.js';
import { findWidgetReferences } from '../../src/plugins/references.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { computeRename } from '../../src/plugins/rename.js';

/** The widget `wrap` is a block widget (its body renders {@children}); the built-in blocks are Spindle's. */
const isBlock = (name: string) => name.toLowerCase() === 'wrap' || isBlockMacro(name);

const SYMBOLS = ['<div>', '</div>', '{if}', '{/if}', '{wrap}', '{/wrap}'];
const widgets = ':: Widgets [widget]\n{widget "wrap"}\n[{@children}]\n{/widget}\n';

/** Two element names, so that an element can close over another one. */
const WIDE = ['<div>', '</div>', '<b>', '</b>', '{if}', '{/if}', '{wrap}', '{/wrap}'];

function* sequences(max: number, symbols: string[] = SYMBOLS): Generator<string[]> {
  let level: string[][] = [[]];
  for (let length = 1; length <= max; length++) {
    level = level.flatMap(prefix => symbols.map(symbol => [...prefix, symbol]));
    yield* level;
  }
}

type Node = { kind: 'macro' | 'html'; name: string; token: Token; index: number };

/** pairMarkup's verdict, and its own stack, replayed on the tokens before the error. */
interface Verdict {
  ok: boolean;
  /** Offset pairMarkup names (the failing token, or the innermost unclosed one). */
  at?: number;
  message?: string;
  /** Index (in the token list) of the token pairMarkup throws at; -1 when it throws at the end. */
  failing: number;
  /** Closer token index -> opener token index, for closers pairMarkup accepts. */
  pairs: Map<number, number>;
  /** Names of the macro containers open when pairMarkup throws. */
  openMacros: string[];
  /** Offset of the node on top of the stack when pairMarkup throws, if any. */
  topStart?: number;
  /**
   * What the pairing does with a closing macro pairMarkup rejects: the index of
   * the opener it pairs with when the containers above that opener are never
   * closed (the author forgot them), -1 when it is stray or crosses a
   * container that is closed later. Undefined for any other failure.
   */
  rejectedPairs?: number;
}

function verdict(text: string): Verdict {
  const tokens = tokenize(text).filter(t => t.type === 'macro' || t.type === 'html');
  const failure = runtimeMarkupFailure(text, isBlock);
  const ok = failure === null;
  const message = failure?.message;
  const at = failure?.at;

  // Replay the stack on the tokens the same way, to learn the pairs
  const stack: Array<{ kind: 'macro' | 'html'; name: string; index: number }> = [];
  const pairs = new Map<number, number>();
  let failing = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'macro') {
      const name = token.name.toLowerCase();
      if (token.isClose) {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 'macro' || top.name !== name) {
          failing = i;
          break;
        }
        stack.pop();
        pairs.set(i, top.index);
      } else if (name === 'if' || name === 'wrap') {
        stack.push({ kind: 'macro', name, index: i });
      }
    } else if (token.type === 'html') {
      if (token.isSelfClose) continue;
      if (token.isClose) {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 'html' || top.name !== token.tag.toLowerCase()) {
          failing = i;
          break;
        }
        stack.pop();
        pairs.set(i, top.index);
      } else {
        stack.push({ kind: 'html', name: token.tag.toLowerCase(), index: i });
      }
    }
  }
  const openMacros = stack.filter(e => e.kind === 'macro').map(e => e.name);
  const top = stack[stack.length - 1];
  const topStart = top ? tokens[top.index].start : undefined;
  let rejectedPairs: number | undefined;
  const failed = failing === -1 ? undefined : tokens[failing];
  if (failed && failed.type === 'macro' && failed.isClose) {
    const key = failed.name.toLowerCase();
    let target = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].kind === 'macro' && stack[i].name === key) {
        target = i;
        break;
      }
    }
    if (target === -1) {
      rejectedPairs = -1;
    } else {
      const later = (entry: { kind: 'macro' | 'html'; name: string }) => tokens.slice(failing + 1).some(t =>
        entry.kind === 'macro'
          ? t.type === 'macro' && t.isClose && t.name.toLowerCase() === entry.name
          : t.type === 'html' && t.isClose && t.tag.toLowerCase() === entry.name);
      const crossing = stack.slice(target + 1).some(later);
      rejectedPairs = crossing ? -1 : stack[target].index;
    }
  }
  return { ok, at, message, failing, pairs, openMacros, topStart, rejectedPairs };
}

const storyUri = 'file:///story.tw';
function workspaceFor(story: string): WorkspaceModel {
  const ws = new WorkspaceModel();
  ws.initialize(new Map([['file:///widgets.tw', widgets], [storyUri, story]]));
  return ws;
}

describe('pairMarkup replay used by this differential', () => {
  it('agrees with the runtime on where it throws', () => {
    let throws = 0;
    for (const sequence of sequences(5)) {
      const text = sequence.join('');
      const v = verdict(text);
      if (v.ok) {
        expect(v.failing, text).toBe(-1);
        continue;
      }
      throws++;
      const tokens = tokenize(text).filter(t => t.type === 'macro' || t.type === 'html');
      if (v.failing !== -1) expect(tokens[v.failing].start, text).toBe(v.at);
      else expect(v.message, text).toMatch(/^Unclosed/);
    }
    expect(throws).toBeGreaterThan(1000);
  });
});

for (const [eolName, eol, max] of [['LF', '\n', 5], ['CRLF', '\r\n', 4]] as const) {
  const symbols = SYMBOLS;
  const header = `:: Start${eol}`;

  describe(`diagnostics against pairMarkup (${eolName})`, () => {
    it('SP101/SP102/SP104 are absent when pairMarkup accepts and name the failing token when it throws', () => {
      let accepted = 0;
      let rejected = 0;
      for (const sequence of [...sequences(max, symbols), ...(eolName === 'LF' ? sequences(4, WIDE) : [])]) {
        const body = sequence.join('');
        const v = verdict(body);
        const story = header + body;
        const ws = workspaceFor(story);
        const doc = TextDocument.create(storyUri, 'twee', 0, story);
        const found = computeDiagnostics(storyUri, ws)
          .filter(d => ['SP101', 'SP102', 'SP104'].includes(d.code as string));
        ws.dispose();
        if (v.ok) {
          accepted++;
          expect(found.map(d => d.message), body).toEqual([]);
          continue;
        }
        rejected++;
        const offsets = found.map(d => doc.offsetAt(d.range.start) - header.length);
        // pairMarkup's own token, or (where the author forgot closers and the
        // pairing closes the container anyway) the node left open on top
        const acceptable = [v.at, v.rejectedPairs !== undefined && v.rejectedPairs !== -1 ? v.topStart : undefined];
        expect(offsets.some(o => acceptable.includes(o)), `${body}: ${v.message}; found ${JSON.stringify(offsets)}`).toBe(true);
      }
      expect(accepted).toBeGreaterThan(20);
      expect(rejected).toBeGreaterThan(1000);
    });
  });
}

for (const [label, symbols, max] of [['six symbols', SYMBOLS, 5], ['eight symbols, two element names', WIDE, 4]] as const) {
describe(`folding against pairMarkup (${label})`, () => {
  it('folds the pairs pairMarkup makes, the ones it recovers after an error included', () => {
    for (const sequence of sequences(max, symbols)) {
      const body = sequence.join('\n');
      const story = `:: Start\n${body}`;
      const lineOf = (offset: number) => body.slice(0, offset).split('\n').length;
      const expected = [...walkNodes(pair(body, isBlock).nodes)]
        .filter(node => node.token.type === 'macro' && node.body?.close)
        .map(node => `${lineOf(node.token.start)}-${lineOf(node.body!.close!.start)}`);
      const ws = workspaceFor(story);
      const folds = computeFoldingRanges(storyUri, ws)
        .filter(r => r.kind === undefined)
        .map(r => `${r.startLine}-${r.endLine}`);
      ws.dispose();
      expect(folds.sort(), `${JSON.stringify(body)}: ${verdict(body).message ?? 'ok'}`).toEqual(expected.sort());
    }
  });
});

describe(`widget heads against pairMarkup (${label})`, () => {
  it('references, definition and rename take the openers and the closers pairMarkup accepts or that close an open container', () => {
    for (const sequence of sequences(max, symbols)) {
      const body = sequence.join('');
      const story = `:: Start\n${body}`;
      const v = verdict(body);
      const tokens = tokenize(body).filter(t => t.type === 'macro' || t.type === 'html');
      const limit = v.failing === -1 ? tokens.length : v.failing + 1;

      // Expected: wrap heads among the tokens up to and including the failing one
      const expected: number[] = [];
      for (let i = 0; i < limit; i++) {
        const t = tokens[i];
        if (t.type !== 'macro' || t.name.toLowerCase() !== 'wrap') continue;
        if (!t.isClose) {
          expected.push(t.start + 1);
        } else if (i !== v.failing || v.openMacros.includes('wrap')) {
          expected.push(t.start + 2);
        }
      }

      const ws = workspaceFor(story);
      const refs = findWidgetReferences('wrap', ws, false)
        .filter(l => l.uri === storyUri)
        .map(l => l.range.start.character)
        .filter(c => c <= (tokens[limit - 1]?.start ?? -1) + 2);
      // definition: on each head of `wrap` in the passage
      const definitions: number[] = [];
      for (const t of tokens.slice(0, limit)) {
        if (t.type !== 'macro' || t.name.toLowerCase() !== 'wrap') continue;
        const character = t.start + (t.isClose ? 2 : 1);
        if (getDefinition(storyUri, { line: 1, character }, ws)) definitions.push(character);
      }
      // rename: the edits in the story
      let renamed: number[] = [];
      try {
        const edits = computeRename(storyUri, { line: 1, character: tokens.find(t => t.type === 'macro' && t.name === 'wrap' && !t.isClose)?.start! + 1 }, 'cover', ws);
        renamed = (edits.get(storyUri) ?? []).map(e => e.range.start.character).filter(c => c <= (tokens[limit - 1]?.start ?? -1) + 2);
      } catch {
        renamed = [];
      }
      ws.dispose();

      const label = `${JSON.stringify(body)}: ${v.message ?? 'ok'}`;
      expect(refs.sort((a, b) => a - b), `refs ${label}`).toEqual(expected);
      expect(definitions, `definition ${label}`).toEqual(expected);
      if (tokens.some(t => t.type === 'macro' && t.name === 'wrap' && !t.isClose)) {
        expect(renamed.sort((a, b) => a - b), `rename ${label}`).toEqual(expected);
      }
    }
  });
});
}
