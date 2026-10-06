/**
 * Contracts K66 (#66): formatting keeps every runtime macro payload intact
 * wherever the macro sits (markup, containers, HTML, odd brace spans), and
 * keeps the document's line-ending style.
 */
import { describe, expect, it } from 'vitest';
import { tokenize } from '../../node_modules/@rohal12/spindle/src/markup/tokenizer.js';
import { formatDocument } from '../../src/plugins/format.js';

/** The runtime view of a passage: compiler-normalized newlines, executable tokens only. */
function payloads(text: string): string[] {
  return tokenize(text.replaceAll('\r\n', '\n'))
    .filter(t => t.type === 'macro' || t.type === 'expression' || t.type === 'link')
    .map(t => (t.type === 'macro' ? `${t.isClose ? '/' : ''}${t.name} ${t.rawArgs}`
      : t.type === 'link' ? `[[${t.target}]]` : t.expression));
}

const EOLS = ['\n', '\r\n'] as const;

describe('K66-payload: multiline macros survive every formatter path', () => {
  const cases: Record<string, string> = {
    'template inside a container (indentation)': ':: Start\n{if $x}\n{set $a = `a\nb`}\n{/if}',
    'template with leading and trailing space lines': ':: Start\n{print `a   \n   b   \n  c`}\n',
    'template with HTML-looking lines (region segmentation)': ':: Start\n{print `\n<div>\nx   y\n</div>\n`}\n',
    'template with a script-looking line': ':: Start\n{print `\n<script>\nlet  a=1\n</script>\n`}\n',
    'template with an svg-looking line': ':: Start\n{print `\n<svg a="1"\n b="2">\n</svg>\n`}\n',
    'template in HTML region': ':: Start\n<div>\n<p>{print `a\n  b`}</p>\n</div>\n',
    'multiline link': ':: Start\n{if $x}\n[[Go|a\nb]]\n{/if}\n',
    'opener with multiline argument keeps its container role': ':: Start\n{if `a\nb` === "x"}\nbody\n{/if}\n',
    'stray brace in a string extends the span': ':: Start\n{if $x}\n{set $s = "{"}\nprose    here }\n  after\n{/if}\n',
    'unterminated macro is text and following macros format': ':: Start\n{if $x}\n{set $y = 1\n{set $z = 2}\n{/if}\n',
    'nested ${} multiline': ':: Start\n{if $x}\n{print `x ${ {a: 1}.a }\n   y   z`}\n{/if}\n',
  };
  for (const eol of EOLS) {
    for (const [name, source] of Object.entries(cases)) {
      it(`K66-payload ${eol.length === 2 ? 'CRLF' : 'LF'}: ${name}`, async () => {
        const text = source.replaceAll('\n', eol);
        const output = await formatDocument(text);
        expect(payloads(output)).toEqual(payloads(text));
        expect(await formatDocument(output)).toBe(output);
      });
    }
  }

  it('K66-payload control: a single-line macro in a container is still indented', async () => {
    expect(await formatDocument(':: Start\n{if $x}\n{set $a = 1}\n{/if}')).toBe(':: Start\n{if $x}\n  {set $a = 1}\n{/if}\n');
  });

  it('K66-payload control: text around a multiline macro is still formatted', async () => {
    const output = await formatDocument(':: Start\n{if $x}\n   prose \n{set $a = `a\n  b`}\n   more \n{/if}');
    expect(output).toBe(':: Start\n{if $x}\n  prose\n  {set $a = `a\n  b`}\n  more\n{/if}\n');
  });
});

describe('K66-eol: formatting keeps the document line-ending style', () => {
  const crlf = (s: string) => s.replaceAll('\n', '\r\n');

  it('K66-eol: a CRLF document stays CRLF throughout', async () => {
    const text = crlf(':: Start   \n{if $x}\nhi \n{set $a = `a\nb`}\n{/if}\n\n\n:: Other\n<div>\n<p>x</p>\n</div>\n:: S [script]\nlet  a=1;\n');
    const output = await formatDocument(text);
    expect(output.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
    expect(output).toBe(crlf(':: Start\n{if $x}\n  hi\n  {set $a = `a\nb`}\n{/if}\n\n:: Other\n<div>\n  <p>x</p>\n</div>\n:: S [script]\nlet a = 1;\n'));
  });

  it('K66-eol: a CRLF document without a final newline gets a CRLF one', async () => {
    expect(await formatDocument(':: Start\r\nhi')).toBe(':: Start\r\nhi\r\n');
  });

  it('K66-eol: an already formatted CRLF document is unchanged (idempotent)', async () => {
    const text = crlf(':: Start\n{if $x}\n  hi\n{/if}\n');
    expect(await formatDocument(text)).toBe(text);
  });

  it('K66-eol: an LF document stays LF', async () => {
    expect(await formatDocument(':: Start\nhi \nthere')).toBe(':: Start\nhi\nthere\n');
  });

  it('K66-eol: mixed endings follow the dominant style', async () => {
    expect(await formatDocument(':: Start\r\na\r\nb\r\nc\n')).toBe(':: Start\r\na\r\nb\r\nc\r\n');
    expect(await formatDocument(':: Start\na\nb\r\nc\n')).toBe(':: Start\na\nb\nc\n');
  });

  it('K66-eol: a CRLF document formats the same as its LF twin', async () => {
    const lf = ':: Start\n{if $x}\n<b>hi</b>\n{else}\nno\n{/if}\n';
    expect(await formatDocument(crlf(lf))).toBe(crlf(await formatDocument(lf)));
  });
});
