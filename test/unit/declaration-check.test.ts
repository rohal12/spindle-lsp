import { describe, it, expect } from 'vitest';
import { checkDeclaration } from '../../src/core/workspace/declaration-check.js';
import { findUnsupportedValue } from '../../src/core/workspace/variable-schema.js';

describe('checkDeclaration', () => {
  it.each([
    '$a = 1', '  $a = 1  ', '\t$a\t=\t1\t', '$a=1', '$5 = 1', '$_ = 1', '$a = 1\r',
    '$a = "http://x"', '$a = "a // b"', "$a = 'x = 1'", '$a = /ab/g', '$a = `t${1}`',
    '$a = new Date()', '$a = 1 /* note */', '$a = 1, 2', '$a = 1) || (2', '$a = foo',
    '$a = [null]', '$a = [undefined, () => 1]', '$a = {b: null, b: 1}', '$a = {...{b: null}}',
    '$a = {f() {}}', '$a = Symbol()', '$a = 1n + 1', '$a = (() => 1)()', '$a = function(){}.name',
    '', '   ',
  ])('accepts %j', (line) => {
    expect(checkDeclaration(line, '$')).toBeUndefined();
  });

  it.each([
    ['// comment', 'StoryVariables: Invalid declaration: "// comment". Expected: $name = value'],
    ['<!-- c -->', 'StoryVariables: Invalid declaration: "<!-- c -->". Expected: $name = value'],
    ['  $x =  ', 'StoryVariables: Invalid declaration: "$x =". Expected: $name = value'],
    ['$a$b = 1', 'StoryVariables: Invalid declaration: "$a$b = 1". Expected: $name = value'],
    ['x = 1', 'StoryVariables: Invalid declaration: "x = 1". Expected: $name = value'],
    ['%x = 1', 'StoryVariables: Invalid declaration: "%x = 1". Expected: $name = value'],
    ['$ä = 1', 'StoryVariables: Invalid declaration: "$ä = 1". Expected: $name = value'],
    ['Some prose.', 'StoryVariables: Invalid declaration: "Some prose.". Expected: $name = value'],
  ])('rejects the declaration %j', (line, message) => {
    const problem = checkDeclaration(line, '$');
    expect(problem?.kind).toBe('invalid');
    expect(problem?.message).toContain(message);
  });

  it('expects the passage sigil: % in StoryTransients', () => {
    expect(checkDeclaration('%x = 1', '%')).toBeUndefined();
    expect(checkDeclaration('$x = 1', '%')).toMatchObject({
      kind: 'invalid',
      message: expect.stringContaining('StoryTransients: Invalid declaration: "$x = 1". Expected: %name = value'),
    });
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
    const problem = checkDeclaration(line, '$');
    expect(problem?.kind).toBe('evaluate');
    const [, name, expr] = /^\$(\w+)\s*=\s*(.+)$/.exec(line)!;
    expect(problem?.message).toContain(`StoryVariables: Failed to evaluate "$${name} = ${expr}": ${error}`);
  });

  it('explains a trailing comment that hides the closing parenthesis', () => {
    expect(checkDeclaration('$a = 1 // note', '$')?.message).toMatch(/comment/);
    expect(checkDeclaration('$a = (1', '$')?.message).not.toMatch(/comment/);
  });

  it.each([
    ['$a = undefined', 'undefined', 'undefined'],
    ['$a = void 0', 'undefined', 'undefined'],
    ['$a = () => 1', 'function', '() => 1'],
    ['$a = x => x', 'function', 'x => x'],
    ['$a = async (x) => { return x }', 'function', 'async (x) => { return x }'],
    ['$a = function () { return 1 }', 'function', 'function () { return 1 }'],
    ['$a = function* gen() {}', 'function', 'function* gen() {}'],
    ['$a = class {}', 'function', 'class {}'],
    ['$a = 1n', 'bigint', '1'],
    ['$a = -12n', 'bigint', '-12'],
  ])('reports %j as an unsupported type', (line, type, value) => {
    const problem = checkDeclaration(line, '$');
    expect(problem?.kind).toBe('unsupported');
    expect(problem?.message).toContain(
      `StoryVariables: Unsupported type "${type}" for value ${value}`,
    );
  });

  it('reports unsupported values nested in objects, with their field', () => {
    expect(checkDeclaration('$a = {b: {c: undefined}}', '$')).toMatchObject({ kind: 'unsupported' });
    expect(checkDeclaration('$a = {b: {c: undefined}}', '$')?.message).toContain('$a.b.c');
    expect(checkDeclaration('$a = {f: () => 1, g: 2}', '$')?.message).toContain('"function"');
    expect(checkDeclaration('$a = {b: undefined, b: 1}', '$')).toBeUndefined();
    expect(checkDeclaration('$a = {b: 1, b: undefined}', '$')).toMatchObject({ kind: 'unsupported' });
  });

  it('reports null as null, with the offsets of the null token', () => {
    expect(checkDeclaration('$a = null', '$')).toMatchObject({ kind: 'null', field: [], start: 5, end: 9 });
    expect(checkDeclaration('  $a = {b: {c: null}}', '$')).toMatchObject({
      kind: 'null', field: ['b', 'c'], start: 15, end: 19,
    });
  });

  it('does not judge lines that the compiled story splits or re-encodes', () => {
    expect(checkDeclaration('$a = 1 \r 2', '$')).toBeUndefined();
    expect(checkDeclaration('$a = 1\u00a0// x', '$')).toBeUndefined();
  });
});

describe('findUnsupportedValue', () => {
  it('ignores values Spindle accepts or that need evaluating', () => {
    for (const expr of [
      '1', '"s"', '[null]', '[undefined]', '{a: [() => 1]}', '{...x, a: undefined}', '{["a"]: undefined}',
      '(() => 1)()', '() => 1, 2', 'undefined + 1', 'void 0 + 1', 'function(){}.length', 'x => x / 2',
      '{a: undefined, ...{a: 1}}', '{get a() { return undefined }}', 'async(1)', '+1n',
    ]) {
      expect(findUnsupportedValue(expr), expr).toBeUndefined();
    }
  });
});
