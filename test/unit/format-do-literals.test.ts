/**
 * Contract K66 (#66): formatting keeps the JavaScript values a {do} body
 * produces. A template literal (or a backslash-continued string) that spans
 * lines is a value, so its line breaks and the whitespace after them stay.
 */
import { describe, expect, it } from 'vitest';
import { formatDocument } from '../../src/plugins/format.js';

describe('K66-do: multiline JavaScript literals in {do} bodies', () => {
  it('issue repro: a template literal keeps its second line', async () => {
    const text = ':: Start\n{do}\nconst value = `a\nb`;\n{/do}\n';
    expect(await formatDocument(text)).toBe(':: Start\n{do}\n  const value = `a\nb`;\n{/do}\n');
  });

  it('is the same with stringAwareBraces and CRLF', async () => {
    const text = ':: Start\r\n{do}\r\nconst value = `a\r\n  b   \r\n`;\r\n{/do}\r\n';
    for (const stringAwareBraces of [false, true]) {
      const output = await formatDocument(text, { stringAwareBraces });
      expect(output).toBe(':: Start\r\n{do}\r\n  const value = `a\r\n  b   \r\n`;\r\n{/do}\r\n');
      expect(await formatDocument(output, { stringAwareBraces })).toBe(output);
    }
  });

  it('keeps an inline do body, a continued string and a nested template', async () => {
    const inline = ':: Start\n{if $v}\n{do}x(`a\n   b`);{/do}\n{/if}\n';
    expect(await formatDocument(inline)).toBe(':: Start\n{if $v}\n  {do}x(`a\n   b`);{/do}\n{/if}\n');
    const continued = ':: Start\n{do}\nx("a\\\n   b");\n{/do}\n';
    expect(await formatDocument(continued)).toBe(':: Start\n{do}\n  x("a\\\n   b");\n{/do}\n');
    const nested = ':: Start\n{do}\nx(`${ `p\n  q` }\n  r`);\n{/do}\n';
    expect(await formatDocument(nested)).toBe(':: Start\n{do}\n  x(`${ `p\n  q` }\n  r`);\n{/do}\n');
  });

  it('is not fooled by backticks and quotes in comments', async () => {
    const text = ':: Start\n{do}\n// it\'s `x\nfoo();\n   bar();\n{/do}\n';
    expect(await formatDocument(text)).toBe(':: Start\n{do}\n  // it\'s `x\n  foo();\n  bar();\n{/do}\n');
  });

  it('control: text around a {do} body and single-line bodies are still formatted', async () => {
    const text = ':: Start\n   prose \n{do}\n   foo();\n{/do}\n';
    expect(await formatDocument(text)).toBe(':: Start\nprose\n{do}\n  foo();\n{/do}\n');
  });
});
