import { describe, it, expect } from 'vitest';
import { parseLinks } from '../../src/core/parsing/link-parser.js';

describe('parseLinks', () => {
  it('extracts [[PassageName]]', () => {
    const refs = parseLinks('[[PassageName]]');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('PassageName');
    expect(refs[0].source).toBe('link');
  });

  it('extracts [[Display|Target]]', () => {
    const refs = parseLinks('[[Display Text|Target]]');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('Target');
  });

  it('extracts multiple links', () => {
    const refs = parseLinks('Go to [[Room A]] or [[Room B]]');
    expect(refs).toHaveLength(2);
    expect(refs[0].name).toBe('Room A');
    expect(refs[1].name).toBe('Room B');
  });

  it('returns empty for no links', () => {
    expect(parseLinks('plain text')).toHaveLength(0);
  });

  it('handles link on specific line', () => {
    const refs = parseLinks('[[Target]]', 5);
    expect(refs[0].range.start.line).toBe(5);
  });

  it('extracts from multi-line text', () => {
    const refs = parseLinks('line 0\n[[A]]\nline 2\n[[B]]');
    expect(refs).toHaveLength(2);
    expect(refs[0].range.start.line).toBe(1);
    expect(refs[1].range.start.line).toBe(3);
  });
});
