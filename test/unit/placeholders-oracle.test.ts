/**
 * Contract K66-scan (#66): the formatter protects exactly the spans the
 * installed Spindle runtime reads as macros, variables, expressions and links,
 * and those in the values of HTML attributes. The oracle is Spindle's own
 * tooling API: the tokens of `tokenizeMarkupTolerant`, and the markup
 * `passagePieces` finds in attribute values.
 *
 * The tokenizer skips string and template literals when it counts braces, so
 * a stray `{` in a string is inert and the span ends at the macro's own `}`.
 * There is one reading: the scan is the tokenizer's.
 */
import { describe, expect, it } from 'vitest';
import { deepTokens, tokenize } from '../helpers/tooling.js';
import { scanSpindleMarkup } from '../../src/plugins/format/placeholders.js';
import { INSTALLED_SPINDLE_VERSION } from '../helpers/spindle-version.js';

const scanSpindleTokens = (text: string) => scanSpindleMarkup(text).tokens;

interface Span { start: number; end: number }

const EXECUTABLE = new Set(['macro', 'variable', 'expression', 'link']);

/**
 * The spans the runtime executes at the top level of the text, plus the macros
 * and variables in the values of HTML attributes (markup of their own).
 */
function oracleSpans(text: string): Span[] {
  const all = deepTokens(text);
  const top = all.filter(t => !t.nested).map(t => t.token);
  const outer = top.filter(t => EXECUTABLE.has(t.type));
  const tags = top.filter(t => t.type === 'html');
  const inAttributes = all
    .filter(t => t.nested && EXECUTABLE.has(t.token.type))
    .map(t => t.token)
    // Markup of a label is part of its macro or link: only the tag's attributes count
    .filter(t => tags.some(tag => t.start >= tag.start && t.end <= tag.end));
  return [...outer, ...inAttributes]
    .map(t => ({ start: t.start, end: t.end }))
    .sort((a, b) => a.start - b.start);
}

const ours = (text: string): Span[] => scanSpindleTokens(text).map(m => ({ start: m.start, end: m.end }));

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
  'do block with an object literal': '{do}\nconst o = {a: 1};\n{/do} {$x}',
  'do block with a template': '{do}\nconst s = `x\n  y`;\n{/do}',
  'html attr macro': '<div class="{$c}">{$x}</div>',
  'html attr with stray brace': '<div title="{">{set $a = 1}</div>',
  'html multi attr': '<a href="x" data-a=\'{$b}\'>[[Go|Home]]</a>',
  'html macro in tag position': '<div {if $x}class="a"{/if}>t</div>',
  'html self closing': '<br/>{$x}<img src="{$s}"/>',
  'html unclosed tag': '<div class="a" {$x}',
  'html attr with a quote inside braces': '<div title="{$a + \'"\'}">{$b}</div>',
  'html attr with a brace in a string': '<div title="{$a + \'{\'}">{$b}</div>',
  'html attr with an unbalanced brace then a quote': '<div title="{" class="x">{$v}</div>',
  'html attr with a template in braces': '<div title="{`}`}">{$v}</div>',
  'html attr with a stray close brace': '<div title="}">{$v}</div>',
  'html custom element': '<my-el a="{$b}">{print 1}</my-el>',
  'html comparison text': 'a < b {set $a = 1} c > d',
  'html tag across lines': '<div\n  class="{$c}"\n>{$x}</div>',
  'html unquoted attr value': '<div class={$c}>{$x}</div>',
  'html comment with markup': '<!-- {if $x} --> {$y}',
};

describe(`K66-scan: scanSpindleTokens matches the Spindle ${INSTALLED_SPINDLE_VERSION} tokenizer`, () => {
  for (const [name, text] of Object.entries(FIXTURES)) {
    it(`K66-scan fixture: ${name}`, () => {
      expect(ours(text)).toEqual(oracleSpans(text));
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
      expect(ours(text), JSON.stringify(text)).toEqual(oracleSpans(text));
    }
  });

  it('K66-scan: attribute values inside recognized tags are scanned too', () => {
    const text = '<div class="{$c}" title=\'{if $x}a{/if}\'>x</div>';
    const found = scanSpindleTokens(text);
    expect(found.map(m => m.token)).toEqual(['{$c}', '{if $x}', '{/if}']);
    expect(found.every(m => m.inAttribute)).toBe(true);
  });

  it('K66-scan: a stray brace in a string does not extend the macro', () => {
    // The string is skipped, so the macro ends at its own `}` and the prose
    // `}` two lines down is text.
    const text = '{set $s = "{"}\nprose   here }\nafter';
    const macros = tokenize(text).filter(t => t.type === 'macro');
    expect(macros).toHaveLength(1);
    expect(macros[0].rawArgs).toBe('$s = "{"');
    expect(scanSpindleTokens(text).map(m => m.token)).toEqual(['{set $s = "{"}']);
  });

  it('K66-scan: the body of {do} is JavaScript, not markup', () => {
    const text = '{do}\nconst o = {a: 1};\nconst s = `x\n  ${ {b: 2}.b }`;\n{/do}\nafter {$v}';
    expect(scanSpindleTokens(text).map(m => m.token)).toEqual(['{do}', '{/do}', '{$v}']);
  });
});
