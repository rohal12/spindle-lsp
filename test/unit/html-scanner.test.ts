import { describe, it, expect } from 'vitest';
import { attributeValueSpans, scanHtmlTags, type HtmlTag } from '../../src/core/parsing/html-scanner.js';

/** The tags of a scan as `<name>`, `</name>` and `<name/>` (void) strings. */
function tags(content: string): string[] {
  return scanHtmlTags(content).tags.map(show);
}

function show(t: HtmlTag): string {
  return t.kind === 'close' ? `</${t.name}>` : t.kind === 'void' ? `<${t.name}/>` : `<${t.name}>`;
}

describe('scanHtmlTags', () => {
  it('finds opening, closing and self-closing tags with their offsets', () => {
    const scan = scanHtmlTags('a <span class="x">b</span> <hr/> c');
    expect(scan.tags.map(show)).toEqual(['<span>', '</span>', '<hr/>']);
    expect(scan.tags[0]).toMatchObject({ start: 2, end: 18 });
    expect(scan.tags[1]).toMatchObject({ start: 19, end: 26 });
    expect(scan.stoppedAt).toBe(-1);
  });

  it('keeps the tag name as written', () => {
    expect(tags('<SPAN>x</Span>')).toEqual(['<SPAN>', '</Span>']);
  });

  it('reads custom element names and names with digits', () => {
    expect(tags('<my-el><h1>x</h1></my-el>')).toEqual(['<my-el>', '<h1>', '</h1>', '</my-el>']);
  });

  it('treats void elements as self-closing, with or without a slash', () => {
    expect(tags('<br><img src="a.png"><wbr/><div/>')).toEqual(['<br/>', '<img/>', '<wbr/>', '<div/>']);
  });

  it('treats every HTML void element as void, including <input>', () => {
    // Spindle 0.45.1 only knows br, col, hr, img and wbr; later versions
    // know all void elements. Assuming the larger set never reports an
    // element as open when some Spindle version closes it.
    const all = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'];
    expect(tags(all.map(t => `<${t}>`).join(''))).toEqual(all.map(t => `<${t}/>`));
  });

  it('drops closing tags of void elements', () => {
    expect(tags('<input type="text"></input><br></br>')).toEqual(['<input/>', '<br/>']);
  });

  it('allows whitespace before the > of a closing tag only', () => {
    expect(tags('<b>x</b \n>')).toEqual(['<b>', '</b>']);
    expect(tags('< b>x</ b>')).toEqual([]);
  });

  it('does not treat a no-break space as whitespace inside a tag', () => {
    // Spindle reads passages through innerHTML, which turns U+00A0 into &nbsp;.
    expect(tags('<a href="x">y</b >')).toEqual([]);
    expect(tags('<a href=x y>z</a>')).toEqual(['<a>', '</a>']);
  });

  it('ignores < that does not start a tag', () => {
    expect(tags('a < b, 1<2, I <3 you, <-, <!-- x -->, <>')).toEqual([]);
  });

  it('recognizes tags inside HTML comments, as Spindle does', () => {
    expect(tags('<!-- <b> -->')).toEqual(['<b>']);
  });

  it('recognizes tags inside <script> and <style>, as Spindle does', () => {
    expect(tags('<script>if (a<b>c) {}</script>')).toEqual(['<script>', '<b>', '</script>']);
  });

  it('reads attribute values containing > and quotes', () => {
    expect(tags(`<a title="a > b" alt='"x"' data-x=y>z</a>`)).toEqual(['<a>', '</a>']);
  });

  it('reads attribute values containing balanced braces', () => {
    const scan = scanHtmlTags('<a title="{$x}" class="{_y ? "a" : "b"}">z</a>');
    expect(scan.tags.map(show)).toEqual(['<a>', '</a>']);
    expect(scan.stoppedAt).toBe(-1);
  });

  it('reads an unquoted value up to whitespace or >', () => {
    // The slash belongs to the value, so this is an opening tag.
    expect(tags('<a href=x/>')).toEqual(['<a>']);
  });

  it('reads boolean, namespaced and @-attributes', () => {
    expect(tags('<input disabled><svg xmlns:xlink="x" @click="f()"></svg>')).toEqual(['<input/>', '<svg>', '</svg>']);
  });

  it('does not find tags in macros, variable displays or links', () => {
    expect(tags('{link "<b>Go</b>"}{/link}')).toEqual([]);
    expect(tags('{$x + "<b>"}{_y}{@z.w}{%t}{.red $a + "<i>"}')).toEqual([]);
    expect(tags('{.red#id print "<i>"}')).toEqual([]);
    expect(tags('[[<b>Go</b>|Next]] [[.c#d <i>|Next]]')).toEqual([]);
  });

  it('lists the offsets of the macros it reads', () => {
    expect(scanHtmlTags('{if $x}<b>{.c else}</b>{$y}{/if}[[{z}]]<i title="{w}">{ v}{u').macros).toEqual([0, 10, 27]);
  });

  it('finds tags after a brace that starts nothing', () => {
    expect(tags('{ <b>x</b> }')).toEqual(['<b>', '</b>']);
    expect(tags('{.red <b>}')).toEqual(['<b>']);
    expect(tags('\\{if <b>x</b>\\}')).toEqual(['<b>', '</b>']);
  });

  it('finds tags after a macro whose brace never closes', () => {
    expect(tags('{if <b>x</b>')).toEqual(['<b>', '</b>']);
  });

  it('skips nested links as a whole', () => {
    expect(tags('[[a [[<b>]] c]]<i>')).toEqual(['<i>']);
  });

  it('stops at an unclosed link', () => {
    const scan = scanHtmlTags('<b>[[x <i>');
    expect(scan.tags.map(show)).toEqual(['<b>']);
    expect(scan.stoppedAt).toBe(3);
  });

  it('stops when Spindle versions disagree on the end of a macro', () => {
    // Spindle 0.45.1 ends the macro at the brace in the string; later
    // versions skip string literals.
    const scan = scanHtmlTags('<b>{print "}"}<i>');
    expect(scan.tags.map(show)).toEqual(['<b>']);
    expect(scan.stoppedAt).toBe(3);
  });

  it('stops when Spindle versions disagree on the end of an attribute value', () => {
    const scan = scanHtmlTags('<b><a title="{">x</a>');
    expect(scan.tags.map(show)).toEqual(['<b>']);
    expect(scan.stoppedAt).toBe(3);
  });

  it('stops at whitespace around an attribute =, which only later versions accept', () => {
    const scan = scanHtmlTags('<b><a href = "x">y</a>');
    expect(scan.tags.map(show)).toEqual(['<b>']);
    expect(scan.stoppedAt).toBe(3);
  });

  it('stops at a tag inside a {do} body, which later versions keep as JavaScript', () => {
    // Later versions emit everything up to the first {/do} as text.
    const scan = scanHtmlTags('<b>{do} s = "<i>"; {/do}</b>');
    expect(scan.tags.map(show)).toEqual(['<b>']);
    expect(scan.stoppedAt).toBe(13);
    expect(scanHtmlTags('<b>{DO}<i>{/do }</b>').stoppedAt).toBe(7);
  });

  it('reads tags around a {do} body, and after a {do} that never closes', () => {
    const scan = scanHtmlTags('<b>{do} a < b; {/do}</b>');
    expect(scan.tags.map(show)).toEqual(['<b>', '</b>']);
    expect(scan.stoppedAt).toBe(-1);
    expect(scanHtmlTags('{do}<i>').stoppedAt).toBe(-1);
  });

  it('stops at a {do} body whose {/do} Spindle 0.45.1 reads as part of something else', () => {
    const scan = scanHtmlTags('<b>{do}{print "{/do}"}<i>');
    expect(scan.tags.map(show)).toEqual(['<b>']);
    expect(scan.stoppedAt).toBe(7);
  });

  it('stops at an even run of backslashes before a brace', () => {
    // 0.45.1 escapes the brace after the last backslash; later versions
    // read \\{ as an escaped backslash before a live brace.
    const scan = scanHtmlTags('<b>\\\\{print "<i>"}');
    expect(scan.tags.map(show)).toEqual(['<b>']);
    expect(scan.stoppedAt).toBe(3);
    expect(tags('\\\\\\{if <b>')).toEqual(['<b>']);
  });

  it('stops at a tag that fails after its attributes', () => {
    // Spindle re-reads such text from the character after <, which would
    // make this scan quadratic.
    const scan = scanHtmlTags('<b>x <y and z. <i>');
    expect(scan.tags.map(show)).toEqual(['<b>']);
    expect(scan.stoppedAt).toBe(5);
  });

  it('stops at an unterminated attribute value', () => {
    const scan = scanHtmlTags('<b><a title="x>y</a>');
    expect(scan.tags.map(show)).toEqual(['<b>']);
    expect(scan.stoppedAt).toBe(3);
  });

  it('scans long malformed input in linear time', () => {
    const inputs = [
      '<a b="'.repeat(20000),
      '[['.repeat(40000),
      '{'.repeat(40000),
      '{$a'.repeat(30000),
      '<a<a '.repeat(20000),
      '<a x=y '.repeat(20000),
      '{.a{$b}'.repeat(20000),
      '<a title="{'.repeat(20000),
      '{do}<b>'.repeat(20000) + '{/do}',
      '<b>\\\\'.repeat(20000) + '{',
    ];
    for (const input of inputs) {
      const t0 = performance.now();
      scanHtmlTags(input);
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });
});

describe('scanHtmlTags attribute values', () => {
  /** The attribute values of each opening or void tag, as text. */
  function values(content: string): string[][] {
    return scanHtmlTags(content).tags
      .filter(t => t.kind !== 'close')
      .map(t => (t.values ?? []).map(([start, end]) => content.slice(start, end)));
  }

  it('records quoted and unquoted values without their quotes', () => {
    expect(values(`<a href="x y" title='z' id=w hidden>`)).toEqual([['x y', 'z', 'w']]);
  });

  it('keeps a macro written inside a quoted value in the value', () => {
    const content = '<span class="{if $x == "a"}on{else}off{/if}">t</span>';
    expect(values(content)).toEqual([['{if $x == "a"}on{else}off{/if}']]);
    expect(scanHtmlTags(content).macros).toEqual([]);
  });

  it('records values of void and self-closing tags', () => {
    expect(values('<img alt="{if $x}a{/if}"><b class="c"/>')).toEqual([['{if $x}a{/if}'], ['c']]);
  });

  it('records no values for text that only looks like a tag', () => {
    // Without a closing >, Spindle reads the tag as text and its braces as macros.
    expect(values('<span class="{if $x}a{/if}" ')).toEqual([]);
  });
});

describe('attributeValueSpans', () => {
  it('lists the attribute values of every passage, in document offsets', () => {
    const text = ':: A\n<b title="{if $x}y{/if}">z</b>\n:: B [t]\n<i class=k>q</i>\n';
    expect(attributeValueSpans(text).map(([s, e]) => text.slice(s, e))).toEqual(['{if $x}y{/if}', 'k']);
  });

  it('does not read a tag across a passage header', () => {
    const text = ':: A\n<b title="x\n:: B\ny">z</b>\n';
    expect(attributeValueSpans(text)).toEqual([]);
  });

  it('stops where the scan stops', () => {
    // `<a href = "x">` makes Spindle re-read the text after `<`.
    const text = ':: A\n<a href = "x"> <b title="{if $x}y{/if}">\n';
    expect(attributeValueSpans(text)).toEqual([]);
  });
});
