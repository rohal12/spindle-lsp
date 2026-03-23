import { describe, it, expect } from 'vitest';
import { replaceSpindleTokens, restoreSpindleTokens } from '../../src/plugins/format/placeholders.js';

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
