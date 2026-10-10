/**
 * Container pairing against Spindle's pairing (`pairMarkup` of the public
 * tooling API, which `parseMarkup` builds its tree with). The runtime accepts
 * a closing macro only when its container is on top of the stack and reports
 * the first closer that is not (`mismatched-closer`, or `stray-closer` with
 * nothing open).
 */
import { describe, expect, it } from 'vitest';
import { runtimeMarkupFailure } from '../helpers/runtime-ast.js';
import { pairMacros, parseMacros } from '../../src/core/parsing/macro-parser.js';

const BLOCKS = new Set(['if', 'for', 'wrap', 'box']);
const isBlock = (name: string) => BLOCKS.has(name.toLowerCase());

/** What the runtime's pairing does with `text`: its first error, as the character it is at (closers only). */
function runtime(text: string): { ok: true } | { ok: false; message: string; code: string; name: string | undefined; at: number | undefined } {
  const failure = runtimeMarkupFailure(text, isBlock);
  if (failure === null) return { ok: true };
  const atCloser = failure.code === 'mismatched-closer' || failure.code === 'stray-closer';
  return { ok: false, message: failure.message, code: failure.code, name: failure.data.name, at: atCloser ? failure.at : undefined };
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

describe('pairMacros against the runtime pairing', { timeout: 60000 }, () => {
  // the story's block widgets (`wrap`, `box`) are block macros for the runtime's pairing (`isBlock` above)

  const symbols = ['{if}', '{/if}', '{for}', '{/for}', '{wrap}', '{/wrap}', '{box}', '{/box}'];

  /** Every sequence of up to `max` symbols. */
  function* sequences(max: number): Generator<string[]> {
    let level: string[][] = [[]];
    for (let length = 1; length <= max; length++) {
      level = level.flatMap(prefix => symbols.map(symbol => [...prefix, symbol]));
      yield* level;
    }
  }

  it('P-valid: a document the runtime accepts pairs every container as it nests it', () => {
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

  it('P-error: the closer the runtime rejects is unpaired when its container is closed later (crossing)', () => {
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
      if (result.code === 'stray-closer') {
        strays++;
        expect(rejected.pair, text).toBe(-1);
        continue;
      }
      // the container the runtime expected a closer for
      const expected = result.name;
      if (result.code !== 'mismatched-closer' || !expected) continue;
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
    expect(result).toMatchObject({ ok: false, code: 'mismatched-closer', message: expect.stringContaining('{/wrap} found where {/if} should close') });
    const { macros } = pairing(text);
    expect(macros.map(m => m.pair)).toEqual([-1, 3, -1, 1]);
    expect(macros[2].expected).toBe('if');
  });

  it('P-missing: containers left open above a closer stay unclosed; the closer pairs with its opener', () => {
    const { macros } = pairing('{if $x}{for @a of []}{/if}');
    expect(macros.map(m => m.pair)).toEqual([2, -1, 0]);
  });

  it('P-case: names are compared case-insensitively, as the runtime lowercases them', () => {
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
});
