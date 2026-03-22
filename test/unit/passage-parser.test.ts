import { describe, it, expect } from 'vitest';
import { parsePassageHeader, isSpecialPassage } from '../../src/core/parsing/passage-parser.js';

describe('parsePassageHeader', () => {
  it('parses a basic passage header', () => {
    const result = parsePassageHeader(':: PassageName', 0);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('PassageName');
    expect(result!.tags).toEqual([]);
    expect(result!.meta).toBeUndefined();
  });

  it('parses tags', () => {
    const result = parsePassageHeader(':: Name [tag1 tag2]', 0);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Name');
    expect(result!.tags).toEqual(['tag1', 'tag2']);
    expect(result!.meta).toBeUndefined();
  });

  it('parses meta JSON', () => {
    const result = parsePassageHeader(':: Name {"position":"100,200"}', 0);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Name');
    expect(result!.tags).toEqual([]);
    expect(result!.meta).toEqual({ position: '100,200' });
  });

  it('parses tags and meta together', () => {
    const result = parsePassageHeader(':: Name [widget nobr] {"position":"0,0"}', 0);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Name');
    expect(result!.tags).toEqual(['widget', 'nobr']);
    expect(result!.meta).toEqual({ position: '0,0' });
  });

  it('handles spaces in passage name', () => {
    const result = parsePassageHeader(':: Name With Spaces [tag]', 0);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Name With Spaces');
    expect(result!.tags).toEqual(['tag']);
  });

  it('returns null for non-header lines', () => {
    expect(parsePassageHeader('Regular text line', 0)).toBeNull();
    expect(parsePassageHeader('', 0)).toBeNull();
    expect(parsePassageHeader('Some :: embedded colons', 0)).toBeNull();
  });

  it('handles empty tags', () => {
    const result = parsePassageHeader(':: Name []', 0);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Name');
    expect(result!.tags).toEqual([]);
  });

  it('computes headerRange spanning the full line', () => {
    const line = ':: PassageName [tag1] {"position":"0,0"}';
    const result = parsePassageHeader(line, 5);
    expect(result).not.toBeNull();
    expect(result!.headerRange).toEqual({
      start: { line: 5, character: 0 },
      end: { line: 5, character: line.length },
    });
  });

  it('computes nameRange spanning just the name', () => {
    const result = parsePassageHeader(':: PassageName [tag1]', 3);
    expect(result).not.toBeNull();
    // ":: " is 3 characters, then "PassageName" is 11 characters
    expect(result!.nameRange).toEqual({
      start: { line: 3, character: 3 },
      end: { line: 3, character: 14 },
    });
  });

  it('computes nameRange for names with spaces', () => {
    const result = parsePassageHeader(':: Name With Spaces [tag]', 0);
    expect(result).not.toBeNull();
    // ":: " is 3 chars, "Name With Spaces" is 16 chars
    expect(result!.nameRange).toEqual({
      start: { line: 0, character: 3 },
      end: { line: 0, character: 19 },
    });
  });

  it('handles passage name only (no tags or meta) with trailing spaces', () => {
    const result = parsePassageHeader(':: PassageName   ', 0);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('PassageName');
    expect(result!.tags).toEqual([]);
    expect(result!.meta).toBeUndefined();
  });

  it('handles invalid meta JSON gracefully', () => {
    const result = parsePassageHeader(':: Name {not valid json}', 0);
    // Invalid JSON meta should cause the line to not match as a valid header
    expect(result).toBeNull();
  });
});

describe('isSpecialPassage', () => {
  it('recognizes StoryVariables as special', () => {
    expect(isSpecialPassage('StoryVariables')).toBe(true);
  });

  it('recognizes StoryInit as special', () => {
    expect(isSpecialPassage('StoryInit')).toBe(true);
  });

  it('recognizes StoryData as special', () => {
    expect(isSpecialPassage('StoryData')).toBe(true);
  });

  it('recognizes StoryTitle as special', () => {
    expect(isSpecialPassage('StoryTitle')).toBe(true);
  });

  it('recognizes StoryBanner as special', () => {
    expect(isSpecialPassage('StoryBanner')).toBe(true);
  });

  it('recognizes StoryCaption as special', () => {
    expect(isSpecialPassage('StoryCaption')).toBe(true);
  });

  it('recognizes StoryMenu as special', () => {
    expect(isSpecialPassage('StoryMenu')).toBe(true);
  });

  it('recognizes StoryInterface as special', () => {
    expect(isSpecialPassage('StoryInterface')).toBe(true);
  });

  it('recognizes StoryAuthor as special', () => {
    expect(isSpecialPassage('StoryAuthor')).toBe(true);
  });

  it('does not recognize regular names as special', () => {
    expect(isSpecialPassage('Regular')).toBe(false);
    expect(isSpecialPassage('Start')).toBe(false);
    expect(isSpecialPassage('My Passage')).toBe(false);
  });
});
