/**
 * Contract F66 / C-F66 (#66): formatting preserves runtime macro payloads.
 * Moved from test/review/convergence.review.ts once the contract passed.
 */
import { describe, expect, it } from 'vitest';
import { tokenize } from '../helpers/tooling.js';
import { formatDocument } from '../../src/plugins/format.js';

/** The compiler normalizes CRLF to LF before tokenizing; so does this view. */
function runtimeMacroArgs(text: string) {
  return tokenize(text.replaceAll('\r\n', '\n')).filter(t => t.type === 'macro').map(t => t.rawArgs);
}

describe('F66: formatting preserves runtime macro payloads (#66)', () => {
  for (const newline of ['\n', '\r\n']) {
    it(`F66-${newline.length}: multiline template in HTML`, async () => {
      const body = '<div>\n<span>{print `a\nb`}</span>\n</div>'.replaceAll('\n', newline);
      const text = `:: StoryVariables${newline}:: Start${newline}${body}`;
      const output = await formatDocument(text);
      expect(runtimeMacroArgs(output)).toEqual(runtimeMacroArgs(text));
      if (newline === '\r\n') expect(output.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
      expect(await formatDocument(output)).toBe(output);
    });
  }

  it('C-F66: single-line HTML macro remains intact and idempotent', async () => {
    const text = ':: StoryVariables\n:: Start\n<div><span>{print "a b"}</span></div>';
    const output = await formatDocument(text);
    expect(runtimeMacroArgs(output)).toEqual(runtimeMacroArgs(text));
    expect(await formatDocument(output)).toBe(output);
  });

  for (const newline of ['\n', '\r\n']) {
    it(`C-F66 (${newline.length}): nested braces, quotes and sibling elements`, async () => {
      const body = [
        '<div>',
        '<p>before</p>',
        '<span>{print `x ${ {a: 1}.a }',
        '  y   z`}</span>',
        '<span>{print "one   two"}</span>',
        '<span>{if true}{print `p',
        'q`}{/if}</span>',
        '</div>',
      ].join(newline);
      const text = `:: StoryVariables${newline}:: Start${newline}${body}`;
      const output = await formatDocument(text);
      expect(runtimeMacroArgs(output)).toEqual(runtimeMacroArgs(text));
      if (newline === '\r\n') expect(output.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
      expect(await formatDocument(output)).toBe(output);
    });
  }

  it('C-F66: a stand-in lookalike in the source is not expanded', async () => {
    const text = ':: Start\n<div>\n<span>{SPML0}</span>\n<span>{print `a\nb`}</span>\n</div>';
    const output = await formatDocument(text);
    expect(output).toContain('{SPML0}');
    expect(runtimeMacroArgs(output)).toEqual(runtimeMacroArgs(text));
  });
});
