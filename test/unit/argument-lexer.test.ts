import { describe, it, expect } from 'vitest';
import { lexArguments, countArguments, ArgType } from '../../src/core/parsing/argument-lexer.js';

describe('lexArguments', () => {
  it('lexes double-quoted string', () => {
    const args = lexArguments('"hello"');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.String);
    expect(args[0].text).toBe('"hello"');
  });

  it('lexes single-quoted string', () => {
    const args = lexArguments("'world'");
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.String);
  });

  it('lexes number', () => {
    const args = lexArguments('42');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.Number);
  });

  it('lexes float', () => {
    const args = lexArguments('3.14');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.Number);
  });

  it('lexes boolean true', () => {
    const args = lexArguments('true');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.Boolean);
  });

  it('lexes boolean false', () => {
    const args = lexArguments('false');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.Boolean);
  });

  it('lexes null', () => {
    const args = lexArguments('null');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.Null);
  });

  it('lexes $ variable', () => {
    const args = lexArguments('$name');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.Variable);
    expect(args[0].sigil).toBe('$');
  });

  it('lexes _ variable', () => {
    const args = lexArguments('_temp');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.Variable);
    expect(args[0].sigil).toBe('_');
  });

  it('lexes @ variable', () => {
    const args = lexArguments('@local');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.Variable);
    expect(args[0].sigil).toBe('@');
  });

  it('lexes dot access', () => {
    const args = lexArguments('$player.health');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.Variable);
    expect(args[0].path).toEqual(['player', 'health']);
  });

  it('lexes link syntax', () => {
    const args = lexArguments('[[Passage Name]]');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.Link);
  });

  it('lexes multiple args', () => {
    const args = lexArguments('"text" $var 42');
    expect(args).toHaveLength(3);
    expect(args[0].type).toBe(ArgType.String);
    expect(args[1].type).toBe(ArgType.Variable);
    expect(args[2].type).toBe(ArgType.Number);
  });

  it('lexes empty string', () => {
    const args = lexArguments('');
    expect(args).toHaveLength(0);
  });

  it('lexes expression fallback', () => {
    const args = lexArguments('$x + 1');
    // This should lex as: variable, expression parts
    expect(args.length).toBeGreaterThanOrEqual(1);
  });

  it('lexes bareword', () => {
    const args = lexArguments('someWord');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.Bareword);
  });

  it('handles escaped characters in double-quoted strings', () => {
    const args = lexArguments('"hello\\"world"');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.String);
  });

  it('handles escaped characters in single-quoted strings', () => {
    const args = lexArguments("'hello\\'world'");
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.String);
  });

  it('lexes backtick expression', () => {
    const args = lexArguments('`$x + 1`');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.Expression);
  });

  it('lexes NaN', () => {
    const args = lexArguments('NaN');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.NaN);
  });

  it('lexes undefined', () => {
    const args = lexArguments('undefined');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.Undefined);
  });

  it('lexes negative number', () => {
    const args = lexArguments('-5');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.Number);
  });

  it('tracks start and end positions', () => {
    const args = lexArguments('"a" "b"');
    expect(args).toHaveLength(2);
    expect(args[0].start).toBe(0);
    expect(args[0].end).toBe(3);
    expect(args[1].start).toBe(4);
    expect(args[1].end).toBe(7);
  });

  it('handles comma-separated args', () => {
    const args = lexArguments('"a", "b"');
    expect(args).toHaveLength(2);
    expect(args[0].type).toBe(ArgType.String);
    expect(args[1].type).toBe(ArgType.String);
  });

  it('lexes deep dot access', () => {
    const args = lexArguments('$a.b.c');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.Variable);
    expect(args[0].path).toEqual(['a', 'b', 'c']);
  });

  it('lexes image syntax', () => {
    const args = lexArguments('[img[photo.jpg]]');
    expect(args).toHaveLength(1);
    expect(args[0].type).toBe(ArgType.Image);
  });
});

describe('countArguments', () => {
  it('counts zero args', () => {
    expect(countArguments('')).toBe(0);
  });

  it('counts one arg', () => {
    expect(countArguments('"hello"')).toBe(1);
  });

  it('counts multiple args', () => {
    expect(countArguments('"a" "b" 42')).toBe(3);
  });
});
