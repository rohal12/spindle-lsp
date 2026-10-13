/**
 * The formatter protects what Spindle's tokenizer reads (`tokenizeMarkupTolerant`),
 * not what a hand-written scan guesses: links and macros are never wrapped
 * apart, the body of {do} is JavaScript and not markup, and tokens in the
 * attribute values of a tag that spans lines are protected from Prettier.
 */
import { describe, expect, it } from 'vitest';
import { formatDocument } from '../../src/plugins/format.js';

describe('format-tokenizer: formatting keeps payloads', () => {
  it('does not wrap inside a link or a macro', async () => {
    const input = ':: Start\nsome words [[Go to the old mill->Mill Road]] more {print "a b c d e f g"} words here\n';
    const output = await formatDocument(input, { maxLineLength: 20 });
    const links = output.match(/\[\[[^\]]*\]\]/g) ?? [];
    expect(links).toEqual(['[[Go to the old mill->Mill Road]]']);
    expect(output).toContain('{print "a b c d e f g"}');
    expect(await formatDocument(output, { maxLineLength: 20 })).toBe(output);
  });

  it('a {do} body is JavaScript: braces and markup-like text in it do not open block bodies', async () => {
    const input = ':: Start\n{do}\nconst o = {if: 1};\nfoo({/if}\n{/do}\nafter\n';
    // `{/if}` inside the body is code, so it closes nothing and `after` stays at the passage level
    expect(await formatDocument(input)).toBe(':: Start\n{do}\n  const o = {if: 1};\n  foo({/if}\n{/do}\nafter\n');
  });

  it('keeps macro and tag text in a tag that spans lines intact', async () => {
    const input = ':: Start\n<div\n  class="{$c}"\n  title=\'{print "a  b"}\'\n>\n  {$x}\n</div>\n';
    const output = await formatDocument(input);
    expect(output).toContain('class="{$c}"');
    expect(output).toContain('{print "a  b"}');
    expect(await formatDocument(output)).toBe(output);
  });
});
