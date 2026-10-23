import { describe, it, expect } from 'vitest';
import { parseTwee } from '@rohal12/twee-ts';
import { parsePassageHeader } from '../../src/core/parsing/passage-parser.js';

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

  it.each(['{not valid json}', '{"position":}'])('keeps the compiler header when metadata %s cannot be decoded', metadata => {
    const line = `:: Name [widget nobr] ${metadata}`;
    const compiled = parseTwee(`${line}\nbody`);
    expect(compiled.passages).toMatchObject([{ name: 'Name', tags: ['widget', 'nobr'], text: 'body' }]);
    expect(compiled.passages[0].metadata).toBeUndefined();
    expect(compiled.diagnostics).toMatchObject([{ level: 'warning', message: expect.stringContaining('could not decode metadata') }]);
    expect(parsePassageHeader(line, 2)).toEqual({
      name: 'Name',
      tags: ['widget', 'nobr'],
      meta: undefined,
      headerRange: { start: { line: 2, character: 0 }, end: { line: 2, character: line.length } },
      nameRange: { start: { line: 2, character: 3 }, end: { line: 2, character: 7 } },
    });
  });

  it.each([
    ':: Name {"position":',
    ':: Name {{x}',
    ':: Name {x}{y}',
    ':: Name {x} trailing',
    ':: Name {"note":"unterminated}',
    ':: Name [broken',
    ':: Name ]',
  ])('rejects malformed header delimiters in %s', line => {
    const compiled = parseTwee(`${line}\nbody`);
    expect(compiled.passages).toEqual([]);
    expect(compiled.diagnostics.some(diagnostic => diagnostic.level === 'error')).toBe(true);
    expect(parsePassageHeader(line, 0)).toBeNull();
  });

  it('ends the header range before a CRLF line ending', () => {
    // A caller that splits at LF keeps the CR: it is the line break, not header text
    const result = parsePassageHeader(':: Start [tag]\r', 2);
    expect(result!.name).toBe('Start');
    expect(result!.headerRange).toEqual({ start: { line: 2, character: 0 }, end: { line: 2, character: 14 } });
  });
});
