import { describe, it, expect } from 'vitest';
import {
  parseMacros,
  pairMacros,
  scanBalancedBrace,
  createCodeScanner,
} from '../../src/core/parsing/macro-parser.js';

describe('parseMacros', () => {
  it('parses simple macro', () => {
    const macros = parseMacros('{set $x = 1}');
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('set');
    expect(macros[0].open).toBe(true);
    expect(macros[0].rawArgs).toBe('$x = 1');
  });

  it('parses closing macro', () => {
    const macros = parseMacros('{/if}');
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('if');
    expect(macros[0].open).toBe(false);
  });

  it('parses CSS prefix', () => {
    const macros = parseMacros('{.red#alert button "Click"}');
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('button');
    expect(macros[0].cssPrefix).toBe('.red#alert');
    expect(macros[0].rawArgs).toBe('"Click"');
  });

  it('skips variable interpolation', () => {
    const macros = parseMacros('{$health}');
    expect(macros).toHaveLength(0);
  });

  it('skips _ variable interpolation', () => {
    const macros = parseMacros('{_temp}');
    expect(macros).toHaveLength(0);
  });

  it('skips @ variable interpolation', () => {
    const macros = parseMacros('{@local}');
    expect(macros).toHaveLength(0);
  });

  it('skips escaped braces', () => {
    const macros = parseMacros('\\{not a macro\\}');
    expect(macros).toHaveLength(0);
  });

  it('parses multiple macros', () => {
    const macros = parseMacros('{if $x}{set $y = 1}{/if}');
    expect(macros).toHaveLength(3);
    expect(macros[0].name).toBe('if');
    expect(macros[1].name).toBe('set');
    expect(macros[2].name).toBe('if');
    expect(macros[2].open).toBe(false);
  });

  it('handles multi-line text with correct positions', () => {
    const text = 'line 0\n{set $x = 1}\nline 2';
    const macros = parseMacros(text);
    expect(macros).toHaveLength(1);
    expect(macros[0].range.start.line).toBe(1);
    expect(macros[0].range.start.character).toBe(0);
  });

  it('parses macro with string args containing braces', () => {
    const macros = parseMacros('{link "text" "passage"}');
    expect(macros).toHaveLength(1);
    expect(macros[0].rawArgs).toBe('"text" "passage"');
  });

  it('parses macro with no args', () => {
    const macros = parseMacros('{back}');
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('back');
    expect(macros[0].rawArgs).toBeUndefined();
  });

  it('handles variable interpolation mixed with macros', () => {
    const macros = parseMacros('Hello {$name}, {set $x = 1}');
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('set');
  });
});

describe('parseMacros balanced braces', () => {
  it('keeps an object literal argument and its closing brace', () => {
    const text = '{set $x = { a: 1, b: 2 }}';
    const macros = parseMacros(text);
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('set');
    expect(macros[0].rawArgs).toBe('$x = { a: 1, b: 2 }');
    expect(macros[0].range.end).toEqual({ line: 0, character: text.length });
  });

  it('keeps every assignment of a comma-separated set with objects', () => {
    const text = '{set $x = {a: 1}, $y = {toString}}after';
    const macros = parseMacros(text);
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('set');
    expect(macros[0].rawArgs).toBe('$x = {a: 1}, $y = {toString}');
    expect(macros[0].range.end).toEqual({ line: 0, character: text.length - 'after'.length });
  });

  it('keeps an object literal passed to a widget invocation', () => {
    const text = '{echo {a: 1}} after';
    const macros = parseMacros(text);
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('echo');
    expect(macros[0].rawArgs).toBe('{a: 1}');
    expect(macros[0].range.end).toEqual({ line: 0, character: 13 });
  });

  it('matches deeply nested objects and continues after the macro', () => {
    const text = '{set $x = {a: {b: {c: 1}}}}\n{if $x.a.b.c}yes{/if}';
    const macros = parseMacros(text);
    expect(macros.map(m => m.name)).toEqual(['set', 'if', 'if']);
    expect(macros[0].rawArgs).toBe('$x = {a: {b: {c: 1}}}');
    expect(macros[0].range.end).toEqual({ line: 0, character: 27 });
    expect(macros[1].range.start).toEqual({ line: 1, character: 0 });
  });

  it('matches objects spanning several lines', () => {
    const text = '{set $x = {\n  a: 1,\n  b: {c: 2}\n}}';
    const macros = parseMacros(text);
    expect(macros).toHaveLength(1);
    expect(macros[0].rawArgs).toBe('$x = {\n  a: 1,\n  b: {c: 2}\n}');
    expect(macros[0].range.end).toEqual({ line: 3, character: 2 });
  });

  it('keeps nested braces after a CSS prefix', () => {
    const macros = parseMacros('{.red button {a: 1}}');
    expect(macros).toHaveLength(1);
    expect(macros[0].cssPrefix).toBe('.red');
    expect(macros[0].rawArgs).toBe('{a: 1}');
  });

  it('ignores braces inside string literals', () => {
    const macros = parseMacros(`{set $x = "}", $y = '{'}{/set}`);
    expect(macros).toHaveLength(2);
    expect(macros[0].rawArgs).toBe(`$x = "}", $y = '{'`);
  });

  it('ignores braces inside template literals and their interpolations', () => {
    const macros = parseMacros('{set $x = `}${ {a: 1}.a }{`}after{b}');
    expect(macros.map(m => m.name)).toEqual(['set', 'b']);
    expect(macros[0].rawArgs).toBe('$x = `}${ {a: 1}.a }{`');
  });

  it('treats an apostrophe after a word character as text, not a string', () => {
    // Spindle: the quote in "name's" cannot start a string literal, so the
    // macro ends at the first balanced brace and {b} is a macro of its own.
    const macros = parseMacros(`{print $name's} and 'x' {b}`);
    expect(macros.map(m => m.name)).toEqual(['print', 'b']);
    expect(macros[0].rawArgs).toBe(`$name's`);
  });

  it('treats a string not closed on its line as text', () => {
    const macros = parseMacros('{print "a}\nb"}');
    expect(macros).toHaveLength(1);
    expect(macros[0].rawArgs).toBe('"a');
  });

  it('treats a macro without a balanced closing brace as text', () => {
    // {set …} never closes; Spindle renders it as text and resumes scanning
    // at the next character, so only {b} is a macro.
    const macros = parseMacros('{set $x = {a: 1}\n{b}');
    expect(macros.map(m => m.name)).toEqual(['b']);
    expect(macros[0].range.start).toEqual({ line: 1, character: 0 });
  });

  it('still skips variable interpolation inside arguments', () => {
    const macros = parseMacros('{set $x = {a: {$y}}}');
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('set');
  });
});

/** Deterministic PRNG (mulberry32) so fuzz inputs are reproducible. */
function seededRandom(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomText(rand: () => number, length: number): string {
  const alphabet = '{{}}``$$\'\'""\\\nab /';
  let s = '';
  for (let i = 0; i < length; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

/**
 * Direct transcription of Spindle's tokenizer scan (exponential on unclosed
 * nested template interpolations), used as the semantic reference on short
 * inputs.
 */
function referenceScan(input: string, i: number): number {
  const skipQuoted = (k: number): number => {
    const quote = input[k];
    let j = k + 1;
    while (j < input.length) {
      const c = input[j];
      if (c === '\\') j += 2;
      else if (c === quote) return j + 1;
      else if (c === '\n') return -1;
      else j++;
    }
    return -1;
  };
  const skipTemplate = (k: number): number => {
    let j = k + 1;
    while (j < input.length) {
      const c = input[j];
      if (c === '\\') j += 2;
      else if (c === '`') return j + 1;
      else if (c === '$' && input[j + 1] === '{') {
        const close = referenceScan(input, j + 2);
        if (close === -1) return -1;
        j = close + 1;
      } else j++;
    }
    return -1;
  };
  let depth = 1;
  while (i < input.length) {
    const c = input[i];
    if (c === '{') depth++;
    else if (c === '}') {
      if (--depth === 0) return i;
    } else if ((c === '"' || c === "'") && !(i > 0 && /[\p{L}\p{N}_\\]/u.test(input[i - 1]))) {
      const end = skipQuoted(i);
      if (end !== -1) {
        i = end;
        continue;
      }
    } else if (c === '`') {
      const end = skipTemplate(i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    i++;
  }
  return -1;
}

describe('createCodeScanner literalEnd', () => {
  it('finds the end of string and template literals', () => {
    const text = 'x = "a}b" + \'c\' + `d${ {e: "`"} }f` + "g\\"h"';
    const scanner = createCodeScanner(text);
    expect(scanner.literalEnd(4)).toBe(9);
    expect(scanner.literalEnd(12)).toBe(15);
    expect(scanner.literalEnd(18)).toBe(35);
    expect(scanner.literalEnd(38)).toBe(text.length);
    expect(scanner.literalEnd(0)).toBe(-1);
  });

  it('treats apostrophes, escaped quotes and unclosed literals as text', () => {
    const text = `don't \\"x" "open\n"a\nb" \`never`;
    const scanner = createCodeScanner(text);
    expect(scanner.literalEnd(3)).toBe(-1);
    expect(scanner.literalEnd(7)).toBe(-1);
    expect(scanner.literalEnd(11)).toBe(-1);
    expect(scanner.literalEnd(17)).toBe(-1);
    expect(scanner.literalEnd(text.indexOf('`'))).toBe(-1);
  });
});

describe('scanBalancedBrace performance', () => {
  it('handles deeply nested unclosed template interpolations in linear time', () => {
    // Each unclosed `${ used to make the enclosing scan redo the inner scan,
    // doubling the work per level (k = 22 took ~100ms, k = 30 minutes).
    const text = '{a ' + '`${'.repeat(2000);
    const start = performance.now();
    expect(parseMacros(text)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('handles many unclosed macro heads and escaped backticks quickly', () => {
    const start = performance.now();
    parseMacros('{a '.repeat(10000));
    parseMacros('{a `' + '\\`'.repeat(10000));
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('completes on random brace/quote/template soup', () => {
    const rand = seededRandom(0x5eed);
    const start = performance.now();
    for (let n = 0; n < 20; n++) parseMacros(randomText(rand, 5000));
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('matches the reference scan on random short inputs', () => {
    const rand = seededRandom(42);
    for (let n = 0; n < 2000; n++) {
      const text = randomText(rand, 30);
      const scanner = createCodeScanner(text);
      for (let i = 0; i <= text.length; i++) {
        const expected = referenceScan(text, i);
        expect(scanBalancedBrace(text, i), `${JSON.stringify(text)} @ ${i}`).toBe(expected);
        expect(scanner.closeBrace(i), `${JSON.stringify(text)} @ ${i}`).toBe(expected);
      }
    }
  });
});

describe('pairMacros', () => {
  it('pairs matching open/close', () => {
    const macros = parseMacros('{if $x}text{/if}');
    pairMacros(macros, (name) => name === 'if');
    expect(macros[0].pair).toBe(macros[1].id);
    expect(macros[1].pair).toBe(macros[0].id);
  });

  it('pairs nested containers', () => {
    const macros = parseMacros('{if $x}{if $y}inner{/if}{/if}');
    pairMacros(macros, (name) => name === 'if');
    // Inner pair
    expect(macros[1].pair).toBe(macros[2].id);
    // Outer pair
    expect(macros[0].pair).toBe(macros[3].id);
  });

  it('leaves non-block macros unpaired', () => {
    const macros = parseMacros('{set $x = 1}');
    pairMacros(macros, () => false);
    expect(macros[0].pair).toBe(-1);
  });

  it('leaves unmatched macros unpaired', () => {
    const macros = parseMacros('{if $x}no closing');
    pairMacros(macros, (name) => name === 'if');
    expect(macros[0].pair).toBe(-1);
  });
});

describe('pairMacros nesting and passage boundaries', () => {
  const isBlock = (name: string) => name === 'if' || name === 'for';

  it('does not pair crossed containers', () => {
    const macros = parseMacros('{if true}{for @x of []}{/if}{/for}');
    pairMacros(macros, isBlock);
    // {/if} closes {if}; the {for} opened inside it is left unclosed
    expect(macros[0].pair).toBe(macros[2].id);
    expect(macros[2].pair).toBe(macros[0].id);
    expect(macros[1].pair).toBe(-1);
    expect(macros[3].pair).toBe(-1);
  });

  it('pairs different containers nested in order', () => {
    const macros = parseMacros('{if true}{for @x of []}{/for}{/if}');
    pairMacros(macros, isBlock);
    expect(macros[0].pair).toBe(macros[3].id);
    expect(macros[1].pair).toBe(macros[2].id);
  });

  it('leaves a stray closing tag unpaired without disturbing open containers', () => {
    const macros = parseMacros('{if true}{/for}{/if}');
    pairMacros(macros, isBlock);
    expect(macros[1].pair).toBe(-1);
    expect(macros[0].pair).toBe(macros[2].id);
  });

  it('does not pair across passage boundaries', () => {
    const text = ':: Start\n{if true}\n:: Other\n{/if}';
    const macros = parseMacros(text);
    pairMacros(macros, isBlock, [0, 2]);
    expect(macros[0].pair).toBe(-1);
    expect(macros[1].pair).toBe(-1);
  });

  it('pairs within each passage when boundaries are given', () => {
    const text = ':: A\n{if true}\n{/if}\n:: B\n{for @x of []}\n{/for}';
    const macros = parseMacros(text);
    pairMacros(macros, isBlock, [0, 3]);
    expect(macros[0].pair).toBe(macros[1].id);
    expect(macros[2].pair).toBe(macros[3].id);
  });
});
