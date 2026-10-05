import { describe, it, expect } from 'vitest';
import { conditionalExpression, findUnevaluatedBlocks } from '../../src/core/parsing/attribute-blocks.js';

const MACROS = new Set(['if', 'else', 'elseif', 'for', 'print', 'set', 'switch', 'case']);
const CONTAINERS = new Set(['if', 'for', 'switch']);
const lookup = {
  isMacro: (name: string) => MACROS.has(name.toLowerCase()),
  isContainer: (name: string) => CONTAINERS.has(name.toLowerCase()),
};

/** The flagged blocks of an attribute value, as [kind, text]. */
function blocks(value: string): Array<[string, string]> {
  return findUnevaluatedBlocks(value, lookup).map(b => [b.kind, value.slice(b.start, b.end)]);
}

describe('findUnevaluatedBlocks', () => {
  it('flags an {if}…{else}…{/if} construct once, as a whole', () => {
    const value = 'card {if @d.delta > 0}delta-positive{else}delta-negative{/if}';
    expect(blocks(value)).toEqual([['macro', '{if @d.delta > 0}delta-positive{else}delta-negative{/if}']]);
    expect(findUnevaluatedBlocks(value, lookup)[0]).toMatchObject({ start: 5, end: value.length, macro: 'if' });
  });

  it('pairs nested containers of the same name', () => {
    expect(blocks('{if $a}{if $b}x{/if}y{/if} z')).toEqual([['macro', '{if $a}{if $b}x{/if}y{/if}']]);
  });

  it('flags a container whose closing tag is not in the value on its own', () => {
    expect(blocks('{if $a}x')).toEqual([['macro', '{if $a}']]);
  });

  it('flags other macros and stray closing tags', () => {
    expect(blocks('{print $x} {else} {/for}')).toEqual([
      ['macro', '{print $x}'],
      ['macro', '{else}'],
      ['macro', '{/for}'],
    ]);
    expect(findUnevaluatedBlocks('{/for}', lookup)[0].macro).toBe('/for');
  });

  it('flags macros with selectors', () => {
    expect(blocks('{.hot if $x}a{/if}')).toEqual([['macro', '{.hot if $x}a{/if}']]);
  });

  it('flags expressions that do not start with a sigil but use a variable', () => {
    expect(blocks(`{!$x ? 'a' : 'b'}`)).toEqual([['expression', `{!$x ? 'a' : 'b'}`]]);
    expect(blocks('{($a + $b)}')).toEqual([['expression', '{($a + $b)}']]);
    expect(blocks('{Math.max(_a, 0)}')).toEqual([['expression', '{Math.max(_a, 0)}']]);
    expect(blocks('{"x" + @y}')).toEqual([['expression', '{"x" + @y}']]);
    expect(blocks('{ %t }')).toEqual([['expression', '{ %t }']]);
  });

  it('does not flag what Spindle evaluates', () => {
    expect(blocks('{$x}')).toEqual([]);
    expect(blocks('{_t} {@l.a} {%t}')).toEqual([]);
    expect(blocks(`{$x > 0 ? 'a' : 'b'}`)).toEqual([]);
    // interpolate() evaluates a block opening with a sigil, word or not
    expect(blocks('{$ x}')).toEqual([]);
    // The inner {$x} is evaluated; the outer braces are text around it
    expect(blocks('{{$x}}')).toEqual([]);
  });

  it('does not look inside an evaluated block', () => {
    expect(blocks(`{$x ? '{if}' : '{!$y}'}`)).toEqual([]);
  });

  it('does not flag braces that are neither a macro nor an expression', () => {
    expect(blocks('{"a":1,"b":[2]}')).toEqual([]);
    expect(blocks('{"price":"$5","who":"_me"}')).toEqual([]);
    expect(blocks('{name} {{mustache}} {} {unknownName $x')).toEqual([]);
    expect(blocks('a{color:red}')).toEqual([]);
    expect(blocks('user@example.com {foo_bar} {a%b}')).toEqual([]);
  });

  it('flags an unknown name that uses a variable as an expression', () => {
    expect(blocks('{greet $x}')).toEqual([['expression', '{greet $x}']]);
  });

  it('skips an escaped brace', () => {
    expect(blocks('\\{if $x}a\\{/if}')).toEqual([]);
  });

  it('finds a macro nested inside text braces', () => {
    expect(blocks('{"cls": "{if $a}x{/if}"}')).toEqual([['macro', '{if $a}x{/if}']]);
  });
});

describe('conditionalExpression', () => {
  it('rewrites {if C}A{else}B{/if} as a conditional expression', () => {
    expect(conditionalExpression('{if @d.delta > 0}delta-positive{else}delta-negative{/if}'))
      .toBe(`{@d.delta > 0 ? 'delta-positive' : 'delta-negative'}`);
  });

  it('rewrites {if C}A{/if} with an empty else', () => {
    expect(conditionalExpression('{if $x}active{/if}')).toBe(`{$x ? 'active' : ''}`);
  });

  it('keeps whitespace in the branches and trims the condition', () => {
    expect(conditionalExpression('{if   _on  } on{else}{/if}')).toBe(`{_on ? ' on' : ''}`);
  });

  it('escapes quotes and backslashes in the branches', () => {
    expect(conditionalExpression(`{if %t}it's{else}a\\b{/if}`)).toBe(`{%t ? 'it\\'s' : 'a\\\\b'}`);
  });

  it('keeps string literals in the condition', () => {
    expect(conditionalExpression('{if $s == "foo"}a{/if}')).toBe(`{$s == "foo" ? 'a' : ''}`);
  });

  it('declines a condition that does not start with a sigil', () => {
    expect(conditionalExpression('{if !$x}a{/if}')).toBeNull();
    expect(conditionalExpression('{if ($x)}a{/if}')).toBeNull();
    expect(conditionalExpression('{if true}a{/if}')).toBeNull();
  });

  it('declines a condition that binds looser than ?:', () => {
    expect(conditionalExpression('{if $a ? $b : $c}a{/if}')).toBeNull();
    expect(conditionalExpression('{if $a = 1}a{/if}')).toBeNull();
    expect(conditionalExpression('{if $a += 1}a{/if}')).toBeNull();
    expect(conditionalExpression('{if $a, $b}a{/if}')).toBeNull();
    expect(conditionalExpression('{if $f(x => x)}a{/if}')).toBeNull();
    expect(conditionalExpression('{if $a >>= 1}a{/if}')).toBeNull();
    expect(conditionalExpression('{if $a ??= 1}a{/if}')).toBeNull();
  });

  it('accepts comparison, optional chaining and nullish operators', () => {
    expect(conditionalExpression('{if $a?.b ?? $c >= 1}a{/if}')).toBe(`{$a?.b ?? $c >= 1 ? 'a' : ''}`);
    expect(conditionalExpression('{if $d !== 2 && $e <= 3 || $f == 1}a{/if}'))
      .toBe(`{$d !== 2 && $e <= 3 || $f == 1 ? 'a' : ''}`);
  });

  it('declines braces, backticks and line breaks', () => {
    expect(conditionalExpression('{if $a}{$b}{/if}')).toBeNull();
    expect(conditionalExpression('{if $a.includes(`x`)}a{/if}')).toBeNull();
    expect(conditionalExpression('{if $a}x\ny{/if}')).toBeNull();
  });

  it('declines other shapes', () => {
    expect(conditionalExpression('{if $a}x{elseif $b}y{/if}')).toBeNull();
    expect(conditionalExpression('{.c if $a}x{/if}')).toBeNull();
    expect(conditionalExpression('{for _i range 3}x{/for}')).toBeNull();
    expect(conditionalExpression('{if $a}x{else}y{else}z{/if}')).toBeNull();
  });
});
