/**
 * Passage bodies are formatted by Spindle's `formatPassage`, which fixed these
 * defects of the formatter spindle-lsp had before it.
 */
import { describe, expect, it } from 'vitest';
import { formatDocument } from '../../src/plugins/format.js';

describe('format: defects fixed by Spindle\'s formatPassage', () => {
  it('leaves a <style> body holding a Spindle token as written, with no placeholder in it', async () => {
    const doc = ':: Start\n<div>\n<style>\n.a { color: {$c}; }\n</style>\n</div>\n';
    const out = await formatDocument(doc);
    expect(out).not.toMatch(/SP:|__SP/);
    expect(out).toContain('{$c}');
    expect(await formatDocument(out)).toBe(out);
  });

  it('keeps the continuation lines of a template literal and a continued string in a <script>', async () => {
    const doc = ':: Start\n<script>\nconst t = `a\nb`;\nconst s = \'a\\\nb\';\n</script>\n';
    const out = await formatDocument(doc);
    expect(out).toContain('`a\nb`');
    expect(out).toContain('"a\\\nb"');
    expect(await formatDocument(out)).toBe(out);
  });

  it('does not change the text HTML displays', async () => {
    const doc = ':: Start\n<p>\n<b>bold</b>, and more!\n</p>\n';
    const out = await formatDocument(doc);
    expect(out).toContain('<b>bold</b>, and more!');
    expect(out).not.toContain('</b> ,');
  });

  it('does not wrap the lines of a {do} body', async () => {
    const line = '  const s = "' + 'word '.repeat(30) + '";';
    const doc = `:: Start\n{do}\n${line}\n{/do}\n`;
    expect(await formatDocument(doc, { maxLineLength: 40 })).toBe(doc);
  });
});
