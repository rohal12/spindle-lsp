/**
 * Contract K66-scan (#66): the formatter protects exactly the spans the
 * installed Spindle runtime (0.45.1) tokenizes as macros, variables,
 * expressions and links. The oracle is Spindle's own tokenizer.
 *
 * Spindle's tokenizer counts braces and ignores string contents, so a stray
 * `{` inside a string extends the macro to the next balanced `}` at runtime.
 * The formatter must protect that same (longer) span: it is the runtime's
 * payload, and reformatting inside it changes the macro's arguments.
 */
import { describe, expect, it } from 'vitest';
import { tokenize } from '../../node_modules/@rohal12/spindle/src/markup/tokenizer.js';
import { scanSpindleTokens } from '../../src/plugins/format/placeholders.js';

interface Span { start: number; end: number }

/** Spans of every executable token the oracle finds outside HTML tags. */
function oracleSpans(text: string): Span[] {
  return tokenize(text)
    .filter(t => t.type === 'macro' || t.type === 'variable' || t.type === 'expression' || t.type === 'link')
    .map(t => ({ start: t.start, end: t.end }));
}

/** Our spans, minus those inside an HTML tag the oracle recognizes (attribute values). */
function ourSpansOutsideTags(text: string): Span[] {
  const tags = tokenize(text).filter(t => t.type === 'html');
  return scanSpindleTokens(text)
    .filter(m => !tags.some(t => m.start >= t.start && m.end <= t.end))
    .map(m => ({ start: m.start, end: m.end }));
}

const FIXTURES: Record<string, string> = {
  'plain macro': 'a {set $x = 1} b',
  'closing': '{if $x}a{/if}',
  'bare closing without name': 'a {/} b',
  'variable': 'Hi {$name}!',
  'variable without name chars': 'a {$ x} b',
  'bare sigil': 'a {$} {_} {@} {%} b',
  'local and transient': '{@a.b} {%c}',
  'expression': '{@node.tier + 1}',
  'nested braces': '{set $o = {a: {b: 1}}}',
  'string with balanced braces': '{print "{a}"}',
  'string with stray open brace': '{set $s = "{"}\nprose   here\n{set $t = 1}',
  'string with stray close brace': '{set $s = "}"} tail {set $t = 1}',
  'stray open brace in template': '{print `{`}\nline  two\n{print "x"}',
  'template with interpolation': '{print `a ${ {a:1}.a } b`}',
  'nested ${} multiline': '{print `x ${ {a: 1}.a }\n  y   z`}',
  'multiline template': '{print `a\nb`}',
  'unterminated macro': '{set $x = 1\nmore text {set $y = 2}',
  'unterminated macro alone': '{set $x = 1',
  'unterminated then valid': '{if {set $a = 1} tail',
  'bare brace': 'a { b } c',
  'escaped open': 'literal \\{not a macro} {set $a = 1}',
  'escaped close': '{set $a = 1}\\} text',
  'escaped backslash then brace': '\\\\{x}',
  'link': 'go [[Home]] now',
  'link pipe': '[[Go|Home]]',
  'link arrow': '[[Go->Home]]',
  'nested link brackets': '[[a [[b]] c]] tail [[d]]',
  'unclosed link': '[[abc {set $a = 1} def',
  'unclosed link then link': '[[abc [[d]]',
  'link with selectors': '[[.red#x Go->Home]]',
  'link selector with interpolation': '[[.a{$v}b Go|Home]]',
  'link containing brace': '[[a {b]] {set $a = 1}',
  'css macro': '{.red#alert if $x}',
  'css macro id first': '{#id.cls print "a"}',
  'css variable': '{.red $name}',
  'css expression': '{.red $a + 1}',
  'css local': '{.red @a}',
  'css temp': '{.red#x _t.f}',
  'css transient': '{.a %t}',
  'css selector with interpolation': '{.a{$v}b if $x}',
  'css selector with bad interpolation': '{.a{$v b if $x}',
  'css selector digits': '{.123 print 1}',
  'css selector no target': '{.a }',
  'css selector closing only': '{.a}',
  'css two spaces': '{.a  print 1}',
  'css bare dot': '{. print 1}',
  'css bare hash': '{# print 1}',
  'css selector then dollar no space': '{.a$x}',
  'css unterminated': '{.a print "x"\n text',
  'dot then letter missing': '{.}',
  'macro with slash name': '{/if x}',
  'macro hyphen name': '{my-widget "a"}',
  'adjacent tokens': '{a}{b}[[c]]{$d}',
  'token at end': 'x {a',
  'only brace': '{',
  'only closing brace': '}',
  'html attr macro': '<div class="{$c}">{$x}</div>',
  'html attr with stray brace': '<div title="{">{set $a = 1}</div>',
  'html multi attr': '<a href="x" data-a=\'{$b}\'>[[Go|Home]]</a>',
  'html macro in tag position': '<div {if $x}class="a"{/if}>t</div>',
  'html self closing': '<br/>{$x}<img src="{$s}"/>',
  'html unclosed tag': '<div class="a" {$x}',
  'html custom element': '<my-el a="{$b}">{print 1}</my-el>',
  'html comparison text': 'a < b {set $a = 1} c > d',
  'html tag across lines': '<div\n  class="{$c}"\n>{$x}</div>',
};

describe('K66-scan: scanSpindleTokens matches the Spindle 0.45.1 tokenizer', () => {
  for (const [name, text] of Object.entries(FIXTURES)) {
    it(`K66-scan fixture: ${name}`, () => {
      expect(ourSpansOutsideTags(text)).toEqual(oracleSpans(text));
    });
  }

  it('K66-scan fuzz: random mixes of brace, string, link and sigil characters', () => {
    // Deterministic LCG so a failure reproduces
    let seed = 0x5eed1234;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000;
    const pieces = [
      '{', '}', '{', '}', '[[', ']]', '[', ']', '\\', '"', "'", '`', '${', '$', '_', '@', '%', '.', '#',
      '/', '-', ' ', ' ', '\n', 'a', 'b', 'if', 'set', 'x', '1', '|', '->', '<-', '<', '>', '=', '<div ', '<a x="', '</div>', '<br/>', 'c=',
    ];
    for (let n = 0; n < 6000; n++) {
      const length = 1 + Math.floor(next() * 24);
      let text = '';
      for (let i = 0; i < length; i++) text += pieces[Math.floor(next() * pieces.length)];
      expect(ourSpansOutsideTags(text), JSON.stringify(text)).toEqual(oracleSpans(text));
    }
  });

  it('K66-scan: attribute values inside recognized tags are scanned too', () => {
    const text = '<div class="{$c}" title=\'{if $x}a{/if}\'>x</div>';
    expect(scanSpindleTokens(text).map(m => m.token)).toEqual(['{$c}', '{if $x}', '{/if}']);
  });

  it('K66-scan: a stray brace in a string protects the runtime span, not the line', () => {
    // The `{` inside the string is counted, so the macro runs on to the
    // prose `}` two lines down: that whole span is its runtime payload.
    const text = '{set $s = "{"}\nprose   here }\nafter';
    const macros = tokenize(text).filter(t => t.type === 'macro');
    expect(macros).toHaveLength(1);
    expect(macros[0].rawArgs).toContain('prose   here');
    expect(scanSpindleTokens(text).map(m => m.token)).toEqual(['{set $s = "{"}\nprose   here }']);
  });

  it('K66-scan control: the same stray brace without a later `}` leaves the macro as text', () => {
    const text = '{set $s = "{"}\nprose   here\n{set $t = 1}';
    expect(tokenize(text).filter(t => t.type === 'macro').map(t => t.rawArgs)).toEqual(['$t = 1']);
    expect(scanSpindleTokens(text).map(m => m.token)).toEqual(['{set $t = 1}']);
  });
});
