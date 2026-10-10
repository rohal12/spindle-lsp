import { describe, it, expect } from 'vitest';
import { readDeclarations } from '../../src/core/workspace/declaration-check.js';

/** The problems of one `$` line, as SP207 reports them. */
function problems(line: string, sigil: '$' | '%' = '$') {
  return readDeclarations(line, sigil).problems;
}

describe('readDeclarations', () => {
  it.each([
    '$a = 1', '  $a = 1  ', '\t$a\t=\t1\t', '$a=1', '$5 = 1', '$_ = 1', '$a = 1\r',
    '$a = "http://x"', '$a = "a // b"', "$a = 'x = 1'", '$a = /ab/g', '$a = `t${1}`',
    '$a = new Date()', '$a = 1 /* note */', '$a = 1, 2', '$a = 1) || (2', '$a = foo',
    '$a = [null]', '$a = [undefined, () => 1]', '$a = {b: null, b: 1}', '$a = {...{b: null}}',
    '$a = null', '$a = {b: {c: null}}', '$a = Symbol()', '$a = 1n + 1', '$a = (() => 1)()',
    '', '   ',
  ])('accepts %j', (line) => {
    expect(problems(line)).toEqual([]);
  });

  it('does not make a problem of a name declared twice: the later one wins', () => {
    const { declarations, problems: found } = readDeclarations('$a = 1\n$a = "again"', '$');
    expect(found).toEqual([]);
    expect(declarations.map(d => d.name)).toEqual(['a', 'a']);
  });

  it.each([
    ['// comment', 'StoryVariables: Invalid declaration: "// comment". Expected: $name = value. StoryVariables has no comment syntax.'],
    ['<!-- c -->', 'StoryVariables: Invalid declaration: "<!-- c -->". Expected: $name = value. StoryVariables has no comment syntax.'],
    ['  $x =  ', 'StoryVariables: Invalid declaration: "$x =". Expected: $name = value.'],
    ['$a$b = 1', 'StoryVariables: Invalid declaration: "$a$b = 1". Expected: $name = value.'],
    ['x = 1', 'StoryVariables: Invalid declaration: "x = 1". Expected: $name = value.'],
    ['%x = 1', 'StoryVariables: Invalid declaration: "%x = 1". Expected: $name = value.'],
    ['$ä = 1', 'StoryVariables: Invalid declaration: "$ä = 1". Expected: $name = value.'],
    ['Some prose.', 'StoryVariables: Invalid declaration: "Some prose.". Expected: $name = value.'],
    ['$__proto__ = 1', 'StoryVariables: "$__proto__" cannot be used as a variable name (__proto__ is reserved).'],
  ])('rejects the line %j', (line, message) => {
    expect(problems(line).map(p => p.message)).toEqual([message]);
  });

  it('expects the passage sigil: % in StoryTransients', () => {
    expect(problems('%x = 1', '%')).toEqual([]);
    expect(problems('$x = 1', '%').map(p => p.message)).toEqual([
      'StoryTransients: Invalid declaration: "$x = 1". Expected: %name = value.',
    ]);
  });

  it.each([
    ['$a = 1 // note', "Unexpected token '}'"],
    ['$a = 1 <!-- note', "Unexpected token '}'"],
    ['$a = [1,', "Unexpected token ')'"],
    ['$a = {', "Unexpected token ')'"],
    ['$a == 1', "Unexpected token '='"],
    ['$a = 1;', "Unexpected token ';'"],
    ['$a = (1', "Unexpected token '}'"],
    ['$a = 1)', "Unexpected token ')'"],
    ['$a = "unterminated', 'Invalid or unexpected token'],
    ['$a = 1 /* x', 'Invalid or unexpected token'],
  ])('reports %j as failing to evaluate', (line, error) => {
    const [, name, expr] = /^\$(\w+)\s*=\s*(.+)$/.exec(line)!;
    const found = problems(line);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain(`StoryVariables: Failed to evaluate "$${name} = ${expr}": ${error}`);
  });

  it('explains a trailing comment that hides the closing parenthesis', () => {
    expect(problems('$a = 1 // note')[0].message).toMatch(/comment/);
    expect(problems('$a = (1')[0].message).not.toMatch(/comment/);
  });

  it.each([
    ['$a = undefined', 'undefined', 'undefined'],
    ['$a = () => 1', 'function', '() => 1'],
    ['$a = x => x', 'function', 'x => x'],
    ['$a = async (x) => { return x }', 'function', 'async (x) => { return x }'],
    ['$a = function () { return 1 }', 'function', 'function () { return 1 }'],
    ['$a = function* gen() {}', 'function', 'function* gen() {}'],
    ['$a = class {}', 'function', 'class {}'],
    ['$a = {f() {}}', 'function', '{f() {}}'],
    ['$a = 1n', 'bigint', '1n'],
    ['$a = -12n', 'bigint', '-12n'],
  ])('reports %j as an unsupported type', (line, type, value) => {
    expect(problems(line).map(p => p.message)).toEqual([
      `StoryVariables: Unsupported type "${type}" for value ${value}. Expected number, string, boolean, array, or object.`,
    ]);
  });

  it('reports unsupported values nested in objects', () => {
    expect(problems('$a = {b: {c: undefined}}')).toHaveLength(1);
    expect(problems('$a = {f: () => 1, g: 2}')[0].message).toContain('"function"');
  });

  it('puts a problem on the line it is on, without the indentation', () => {
    const content = '$ok = 1\n  $bad = undefined  \n// note\n';
    const { text, problems: found } = readDeclarations(content, '$');
    expect(found.map(p => text.slice(p.start, p.end))).toEqual(['$bad = undefined', '// note']);
  });

  it('reads CRLF content as the compiler passes it on, and stops at the next header', () => {
    const { text, declarations, problems: found } = readDeclarations('$a = 1\r\n$b = (\r\n::Other\r\n$c = 1', '$');
    expect(text).toBe('$a = 1\n$b = (');
    expect(declarations.map(d => d.name)).toEqual(['a', 'b']);
    expect(found.map(p => text.slice(p.start, p.end))).toEqual(['$b = (']);
  });

  it('does not judge lines that the compiled story splits or re-encodes', () => {
    expect(problems('$a = 1 \r 2')).toEqual([]);
    expect(problems('$a = 1 // x')).toEqual([]);
  });
});
