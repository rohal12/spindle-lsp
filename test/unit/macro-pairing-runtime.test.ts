/**
 * Container pairing against Spindle's AST builder (markup/ast.ts), the
 * installed runtime (0.45.1). buildAST accepts a closing macro only when its
 * container is on top of the stack and throws at the first closer that is not.
 */
import { describe, expect, it } from 'vitest';
import { buildAST, registerBlockMacro, unregisterBlockMacro } from '../../node_modules/@rohal12/spindle/src/markup/ast.js';
import { tokenize } from '../helpers/tooling.js';
import { pairMacros, parseMacros } from '../../src/core/parsing/macro-parser.js';

const BLOCKS = new Set(['if', 'for', 'wrap', 'box']);
const isBlock = (name: string) => BLOCKS.has(name.toLowerCase());

/** What buildAST does with `text`, as the character where it throws. */
function runtime(text: string): { ok: true } | { ok: false; message: string; at: number | undefined } {
  try {
    buildAST(tokenize(text));
    return { ok: true };
  } catch (error) {
    const message = (error as Error).message;
    const at = /at character (\d+)/.exec(message)?.[1];
    return { ok: false, message, at: at === undefined ? undefined : Number(at) };
  }
}

function pairing(text: string) {
  const macros = parseMacros(text);
  pairMacros(macros, isBlock);
  const offsets: number[] = [];
  let offset = 0;
  for (const macro of macros) {
    offset = text.indexOf(macro.open ? `{${macro.name}` : `{/${macro.name}`, offset);
    offsets.push(offset);
    offset += 1;
  }
  return { macros, offsets };
}

describe('pairMacros against buildAST', { timeout: 60000 }, () => {
  // Spindle registers its own widgets as block macros at startup
  const registered = ['wrap', 'box'];
  for (const name of registered) registerBlockMacro(name);
  // (unregistered after the last test in this file)

  const symbols = ['{if}', '{/if}', '{for}', '{/for}', '{wrap}', '{/wrap}', '{box}', '{/box}'];

  /** Every sequence of up to `max` symbols. */
  function* sequences(max: number): Generator<string[]> {
    let level: string[][] = [[]];
    for (let length = 1; length <= max; length++) {
      level = level.flatMap(prefix => symbols.map(symbol => [...prefix, symbol]));
      yield* level;
    }
  }

  it('P-valid: a document buildAST accepts pairs every container as buildAST nests it', () => {
    let accepted = 0;
    for (const sequence of sequences(6)) {
      const text = sequence.join('');
      if (!runtime(text).ok) continue;
      accepted++;
      const { macros } = pairing(text);
      const stack: number[] = [];
      for (const macro of macros) {
        if (macro.open) {
          stack.push(macro.id);
        } else {
          const opener = stack.pop()!;
          expect(macro.pair, text).toBe(opener);
          expect(macros[opener].pair, text).toBe(macro.id);
        }
      }
    }
    expect(accepted).toBeGreaterThan(100);
  });

  it('P-error: the closer buildAST rejects is unpaired when its container is closed later (crossing)', () => {
    let crossings = 0;
    let strays = 0;
    for (const sequence of sequences(5)) {
      const text = sequence.join('');
      const result = runtime(text);
      if (result.ok || result.at === undefined) continue;
      const { macros, offsets } = pairing(text);
      const index = offsets.indexOf(result.at);
      expect(index, text).toBeGreaterThanOrEqual(0);
      const rejected = macros[index];
      if (result.message.startsWith('Unexpected closing')) {
        strays++;
        expect(rejected.pair, text).toBe(-1);
        continue;
      }
      const expected = /Expected \{\/(\w+)\}/.exec(result.message)?.[1];
      if (!expected) continue;
      const closedLater = macros.slice(index + 1).some(m => !m.open && m.name === expected);
      if (closedLater) {
        crossings++;
        expect(rejected.pair, text).toBe(-1);
      }
    }
    expect(crossings).toBeGreaterThan(100);
    expect(strays).toBeGreaterThan(100);
  });

  it('P-nesting: the pairs made never cross, whatever the input', () => {
    for (const sequence of sequences(5)) {
      const text = sequence.join('');
      const { macros } = pairing(text);
      const stack: number[] = [];
      for (const macro of macros) {
        if (macro.pair === -1) continue;
        expect(macros[macro.pair].pair, text).toBe(macro.id);
        expect(macros[macro.pair].name, text).toBe(macro.name);
        if (macro.open) {
          stack.push(macro.id);
        } else {
          expect(stack.pop(), text).toBe(macro.pair);
        }
      }
    }
  });

  it('P-widget-crossed: {wrap}{if}{/wrap}{/if} blames {/wrap} as Spindle does and pairs {if} with {/if}', () => {
    const text = '{wrap}{if $x}{/wrap}{/if}';
    const result = runtime(text);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Expected {/if} but found {/wrap}') });
    const { macros } = pairing(text);
    expect(macros.map(m => m.pair)).toEqual([-1, 3, -1, 1]);
    expect(macros[2].expected).toBe('if');
  });

  it('P-missing: containers left open above a closer stay unclosed; the closer pairs with its opener', () => {
    const { macros } = pairing('{if $x}{for @a of []}{/if}');
    expect(macros.map(m => m.pair)).toEqual([2, -1, 0]);
  });

  it('P-case: names are compared case-insensitively, as buildAST lowercases them', () => {
    const text = '{If $x}{/IF}';
    expect(runtime(text).ok).toBe(true);
    expect(pairing(text).macros.map(m => m.pair)).toEqual([1, 0]);
  });

  it('P-passages: pairing restarts at each passage header', () => {
    const text = ':: A\n{wrap}{if $x}\n:: B\n{/if}{/wrap}';
    const macros = parseMacros(text);
    pairMacros(macros, isBlock, [0, 2]);
    expect(macros.map(m => m.pair)).toEqual([-1, -1, -1, -1]);
  });

  for (const eol of ['\n', '\r\n']) {
    it(`P-eol(${JSON.stringify(eol)}): crossing is judged per passage whatever the line ending`, () => {
      const text = [':: A', '{wrap}{if $x}{/wrap}', '{/if}', ':: B', '{wrap}x{/wrap}'].join(eol);
      const macros = parseMacros(text);
      pairMacros(macros, isBlock, [0, 3]);
      expect(macros.map(m => m.pair)).toEqual([-1, 3, -1, 1, 5, 4]);
    });
  }

  it('cleanup', () => {
    for (const name of registered) unregisterBlockMacro(name);
  });
});
