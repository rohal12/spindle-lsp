import { describe, it, expect } from 'vitest';
import { splitPassages, classifyPassage } from '../../src/plugins/format/segment.js';

describe('splitPassages', () => {
  it('splits document into passages', () => {
    const input = ':: Start\nContent\n\n:: Next [tag]\nMore\n';
    const passages = splitPassages(input);
    expect(passages).toHaveLength(2);
    expect(passages[0].header).toBe(':: Start');
    expect(passages[0].body).toBe('Content\n');
    expect(passages[1].header).toBe(':: Next [tag]');
    expect(passages[1].body).toBe('More\n');
  });

  it('handles document with no passage headers', () => {
    const input = 'Just some text\n';
    const passages = splitPassages(input);
    expect(passages).toHaveLength(1);
    expect(passages[0].header).toBe('');
    expect(passages[0].body).toBe('Just some text\n');
  });
});

describe('classifyPassage', () => {
  it('classifies script passages', () => {
    expect(classifyPassage(':: Init [script]')).toBe('script');
  });

  it('classifies stylesheet passages', () => {
    expect(classifyPassage(':: Styles [stylesheet]')).toBe('stylesheet');
  });

  it('classifies normal passages', () => {
    expect(classifyPassage(':: Start')).toBe('normal');
    expect(classifyPassage(':: Start [widget]')).toBe('normal');
  });

  it('detects script/stylesheet within a multi-tag list', () => {
    expect(classifyPassage(':: JS [script extra]')).toBe('script');
    expect(classifyPassage(':: JS [extra script]')).toBe('script');
    expect(classifyPassage(':: JS [a  script\tb]')).toBe('script');
    expect(classifyPassage(':: CSS [stylesheet extra]')).toBe('stylesheet');
    expect(classifyPassage(':: CSS [extra stylesheet]')).toBe('stylesheet');
    expect(classifyPassage(':: Start [scripted extra]')).toBe('normal');
  });

  it('does not read escaped brackets in the passage name as tags', () => {
    expect(classifyPassage(':: A\\[script]')).toBe('normal');
    expect(classifyPassage(':: A\\[script\\]')).toBe('normal');
    expect(classifyPassage(':: A\\[B\\] [script]')).toBe('script');
    expect(classifyPassage(':: A\\{x\\} [stylesheet] {"a": 1}')).toBe('stylesheet');
  });

  it('does not read brackets in metadata as tags', () => {
    expect(classifyPassage(':: Start {"note": "[script]"}')).toBe('normal');
    expect(classifyPassage(':: Init [script] {"note": "[stylesheet]"}')).toBe('script');
  });

  it('preserves case-sensitive compiler tag membership (#35)', () => {
    expect(classifyPassage(':: Init [Script]')).toBe('normal');
    expect(classifyPassage(':: Styles [Stylesheet]')).toBe('normal');
  });
});
