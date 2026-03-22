import { describe, it, expect } from 'vitest';
import { formatDocument, formatRange } from '../../src/plugins/format.js';

describe('formatDocument', () => {
  it('indents content inside block macros by 2 spaces', () => {
    const input = ':: Start\n{if $x}\n{set $y = 1}\n{/if}\n';
    const result = formatDocument(input);
    const lines = result.split('\n');
    expect(lines[2]).toBe('  {set $y = 1}');
  });

  it('handles nested indentation (2 and 4 spaces)', () => {
    const input = ':: Start\n{if $x}\n{for @item range $list}\n{set $y = 1}\n{/for}\n{/if}\n';
    const result = formatDocument(input);
    const lines = result.split('\n');
    expect(lines[2]).toBe('  {for @item range $list}');
    expect(lines[3]).toBe('    {set $y = 1}');
    expect(lines[4]).toBe('  {/for}');
    expect(lines[5]).toBe('{/if}');
  });

  it('removes trailing whitespace from lines', () => {
    const input = ':: Start   \nHello world   \n';
    const result = formatDocument(input);
    const lines = result.split('\n');
    expect(lines[0]).toBe(':: Start');
    expect(lines[1]).toBe('Hello world');
  });

  it('ensures file ends with a single newline', () => {
    const input = ':: Start\nHello world';
    const result = formatDocument(input);
    expect(result.endsWith('\n')).toBe(true);
    expect(result.endsWith('\n\n')).toBe(false);
  });

  it('collapses multiple trailing newlines to one', () => {
    const input = ':: Start\nHello world\n\n\n\n';
    const result = formatDocument(input);
    expect(result).toBe(':: Start\nHello world\n');
  });

  it('normalizes passage headers with extra whitespace', () => {
    const input = '::  Name  [tag]\nContent\n';
    const result = formatDocument(input);
    const lines = result.split('\n');
    expect(lines[0]).toBe(':: Name [tag]');
  });

  it('normalizes passage header with metadata braces', () => {
    const input = '::  MyPassage  {"position": "100,200"}\nContent\n';
    const result = formatDocument(input);
    const lines = result.split('\n');
    expect(lines[0]).toBe(':: MyPassage {"position": "100,200"}');
  });

  it('returns already-formatted document unchanged', () => {
    const input = ':: Start\n{if $x}\n  {set $y = 1}\n{/if}\n';
    const result = formatDocument(input);
    expect(result).toBe(input);
  });

  it('resets indent level at passage boundaries', () => {
    const input = ':: Passage1\n{if $x}\nContent\n\n:: Passage2\nMore content\n';
    const result = formatDocument(input);
    const lines = result.split('\n');
    // Passage2 content should not be indented
    expect(lines[5]).toBe('More content');
  });

  it('handles empty input', () => {
    const result = formatDocument('');
    expect(result).toBe('\n');
  });

  it('handles widget blocks', () => {
    const input = ':: Widgets [widget]\n{widget "greet" @name}\nHello {@name}\n{/widget}\n';
    const result = formatDocument(input);
    const lines = result.split('\n');
    expect(lines[2]).toBe('  Hello {@name}');
    expect(lines[3]).toBe('{/widget}');
  });
});

describe('formatRange', () => {
  it('formats only the specified line range', () => {
    const input = ':: Start\n{if $x}\n{set $y = 1}\n{/if}\n:: Next\nContent\n';
    const result = formatRange(input, {
      start: { line: 1, character: 0 },
      end: { line: 3, character: 4 },
    });
    const lines = result.split('\n');
    expect(lines[2]).toBe('  {set $y = 1}');
    expect(lines[5]).toBe('Content');
  });

  it('handles range at start of document', () => {
    const input = '::  Start  [tag]\nContent\n';
    const result = formatRange(input, {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    });
    const lines = result.split('\n');
    expect(lines[0]).toBe(':: Start [tag]');
  });
});
