import { describe, it, expect } from 'vitest';
import { splitPassages, classifyPassage, segmentRegions } from '../../src/plugins/format/segment.js';

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

  it('handles case-insensitive tags', () => {
    expect(classifyPassage(':: Init [Script]')).toBe('script');
    expect(classifyPassage(':: Styles [Stylesheet]')).toBe('stylesheet');
  });
});

describe('segmentRegions', () => {
  it('classifies plain Spindle lines as spindle regions', () => {
    const regions = segmentRegions('{if $x}\ncontent\n{/if}\n');
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe('spindle');
  });

  it('detects inline <script> blocks', () => {
    const input = 'text\n<script>\nconst x = 1;\n</script>\nmore\n';
    const regions = segmentRegions(input);
    const types = regions.map(r => r.type);
    expect(types).toContain('script');
    expect(types.filter(t => t === 'spindle')).toHaveLength(2);
  });

  it('detects multi-line HTML blocks', () => {
    const input = '{if $x}\n<div>\n  <span>text</span>\n</div>\n{/if}\n';
    const regions = segmentRegions(input);
    const types = regions.map(r => r.type);
    expect(types).toContain('html');
  });

  it('does NOT treat single-line inline HTML as HTML block', () => {
    const input = 'text <em>bold</em> more\n';
    const regions = segmentRegions(input);
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe('spindle');
  });

  it('does NOT treat single-line HTML tags starting a line as HTML block', () => {
    const input = '<br>\n{set $x = 1}\n';
    const regions = segmentRegions(input);
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe('spindle');
  });

  it('detects multi-line HTML starting with non-void tag', () => {
    const input = '<div class="foo">\n  <p>hello</p>\n</div>\n';
    const regions = segmentRegions(input);
    expect(regions[0].type).toBe('html');
  });
});
