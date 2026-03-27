import { describe, it, expect } from 'vitest';
import { replaceSpindleTokens, restoreSpindleTokens, scanSpindleTokens } from '../../src/plugins/format/placeholders.js';

describe('replaceSpindleTokens', () => {
  it('replaces macro calls with comment placeholders', () => {
    const input = '<div>{set $x = 1}</div>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(text).not.toContain('{set $x = 1}');
    expect(text).toContain('<!--SP:0-->');
    expect(tokens[0]).toBe('{set $x = 1}');
  });

  it('replaces closing macros', () => {
    const input = '<div>{if $x}hello{/if}</div>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(text).not.toContain('{if $x}');
    expect(text).not.toContain('{/if}');
    expect(tokens).toHaveLength(2);
  });

  it('replaces variable displays', () => {
    const input = '<span>{$playerName}</span>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(text).not.toContain('{$playerName}');
    expect(tokens[0]).toBe('{$playerName}');
  });

  it('replaces Spindle links', () => {
    const input = '<div>[[Home]]</div>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(text).not.toContain('[[Home]]');
    expect(tokens[0]).toBe('[[Home]]');
  });

  it('uses attribute-safe placeholders inside attribute values', () => {
    const input = '<div class="{$className}">text</div>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(text).toContain('__SP0__');
    expect(text).not.toContain('<!--');
    expect(tokens[0]).toBe('{$className}');
  });

  it('handles multiple tokens', () => {
    const input = '<div>{$a}</div><span>{$b}</span>';
    const { text, tokens } = replaceSpindleTokens(input);
    expect(tokens).toHaveLength(2);
    expect(text).toContain('<!--SP:0-->');
    expect(text).toContain('<!--SP:1-->');
  });
});

describe('restoreSpindleTokens', () => {
  it('round-trips tokens back to original', () => {
    const original = '<div>{$playerName}</div>';
    const { text, tokens } = replaceSpindleTokens(original);
    const restored = restoreSpindleTokens(text, tokens);
    expect(restored).toBe(original);
  });

  it('round-trips attribute tokens', () => {
    const original = '<div class="{$cls}">text</div>';
    const { text, tokens } = replaceSpindleTokens(original);
    const restored = restoreSpindleTokens(text, tokens);
    expect(restored).toBe(original);
  });

  it('round-trips multiple mixed tokens', () => {
    const original = '<div class="{$cls}">{$name} [[Home]]</div>';
    const { text, tokens } = replaceSpindleTokens(original);
    const restored = restoreSpindleTokens(text, tokens);
    expect(restored).toBe(original);
  });
});

describe('scanSpindleTokens', () => {
  it('finds closing tags', () => {
    const result = scanSpindleTokens('hello {/if} world');
    expect(result).toEqual([{ start: 6, end: 11, token: '{/if}' }]);
  });

  it('finds macro calls', () => {
    const result = scanSpindleTokens('text {set $x = 1} more');
    expect(result).toEqual([{ start: 5, end: 17, token: '{set $x = 1}' }]);
  });

  it('finds CSS-prefixed macros', () => {
    const result = scanSpindleTokens('{.red#alert if $x}');
    expect(result).toEqual([{ start: 0, end: 18, token: '{.red#alert if $x}' }]);
  });

  it('finds simple variable interpolations', () => {
    const result = scanSpindleTokens('Hi {$name}!');
    expect(result).toEqual([{ start: 3, end: 10, token: '{$name}' }]);
  });

  it('finds expression interpolations with operators', () => {
    const result = scanSpindleTokens('row: {@node.tier + 1}');
    expect(result).toEqual([{ start: 5, end: 21, token: '{@node.tier + 1}' }]);
  });

  it('finds expression interpolations with nested braces', () => {
    const result = scanSpindleTokens('val: {@list[{$index}]}');
    expect(result).toEqual([{ start: 5, end: 22, token: '{@list[{$index}]}' }]);
  });

  it('finds % transient variable interpolations', () => {
    const result = scanSpindleTokens('temp: {%counter}');
    expect(result).toEqual([{ start: 6, end: 16, token: '{%counter}' }]);
  });

  it('finds [[links]]', () => {
    const result = scanSpindleTokens('go to [[Home]]');
    expect(result).toEqual([{ start: 6, end: 14, token: '[[Home]]' }]);
  });

  it('skips escaped braces', () => {
    const result = scanSpindleTokens('literal \\{not a macro}');
    expect(result).toEqual([]);
  });

  it('skips bare braces with no sigil or name', () => {
    const result = scanSpindleTokens('css { color: red }');
    expect(result).toEqual([]);
  });

  it('finds multiple tokens', () => {
    const result = scanSpindleTokens('{$a} and {$b}');
    expect(result).toHaveLength(2);
    expect(result[0].token).toBe('{$a}');
    expect(result[1].token).toBe('{$b}');
  });

  it('finds tokens adjacent to HTML', () => {
    const result = scanSpindleTokens('<span>{@node.tier + 1}</span>');
    expect(result).toEqual([{ start: 6, end: 22, token: '{@node.tier + 1}' }]);
  });
});
