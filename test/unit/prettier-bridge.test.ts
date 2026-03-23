import { describe, it, expect } from 'vitest';
import { formatJS, formatCSS, formatHTML, isPrettierAvailable } from '../../src/plugins/format/prettier-bridge.js';

describe('prettier-bridge', () => {
  it('isPrettierAvailable returns true when prettier is installed', async () => {
    expect(await isPrettierAvailable()).toBe(true);
  });

  it('formats JavaScript code', async () => {
    const input = 'const   x=1;const y = 2';
    const result = await formatJS(input);
    expect(result).toContain('const x = 1;');
    expect(result).toContain('const y = 2;');
  });

  it('formats CSS code', async () => {
    const input = '.foo{color:red;display:block}';
    const result = await formatCSS(input);
    expect(result).toContain('color: red;');
    expect(result).toContain('display: block;');
  });

  it('formats HTML code', async () => {
    const input = '<div><span>text</span><p>para</p></div>';
    const result = await formatHTML(input);
    expect(result).toContain('<div>');
    expect(result).toContain('<span>');
  });

  it('returns input unchanged on malformed JS', async () => {
    const input = 'const x = {{{';
    const result = await formatJS(input);
    expect(result).toBe(input);
  });

  it('returns input unchanged on malformed CSS', async () => {
    const input = '.foo { color: }}}';
    const result = await formatCSS(input);
    expect(result).toBe(input);
  });

  it('returns input unchanged on malformed HTML', async () => {
    const input = '<div id=">';
    const result = await formatHTML(input);
    expect(result).toBe(input);
  });
});
