import { describe, it, expect } from 'vitest';
import {
  inferDefaultSchema,
  findPrimitiveFieldAccess,
  type ValueSchema,
} from '../../src/core/workspace/variable-schema.js';

/** A schema as a plain object, for readable assertions. */
function plain(schema: ValueSchema | null | undefined): unknown {
  if (schema == null) return schema;
  if (!schema.fields) return schema.type;
  return Object.fromEntries([...schema.fields].map(([k, v]) => [k, plain(v)]));
}

describe('inferDefaultSchema', () => {
  it.each([
    ['5', 'number'],
    ['-5', 'number'],
    ['+.5e3', 'number'],
    ['1.', 'number'],
    ['true', 'boolean'],
    ['false', 'boolean'],
    ['"Bob"', 'string'],
    ["'it\\'s'", 'string'],
    ['`plain`', 'string'],
    ['""', 'string'],
    ['[]', 'array'],
    ['[1, "a", {b: 2}, [3]]', 'array'],
    ['[x, y => y + 1, (1, 2)]', 'array'],
  ])('types the literal %s as %s', (expr, type) => {
    expect(plain(inferDefaultSchema(expr))).toBe(type);
  });

  it('records the fields of object literals, nested ones too', () => {
    const schema = inferDefaultSchema('{ hp: 10, name: "Hero", inv: [], stats: { str: 1, tags: { a: true } } }');
    expect(plain(schema)).toEqual({
      hp: 'number',
      name: 'string',
      inv: 'array',
      stats: { str: 'number', tags: { a: 'boolean' } },
    });
  });

  it('reads quoted and array-index keys, and keeps the last of duplicate keys', () => {
    expect(plain(inferDefaultSchema('{"a": 1, \'b\': "x", 2: true, a: {c: 1},}'))).toEqual({
      a: { c: 'number' },
      b: 'string',
      2: 'boolean',
    });
  });

  it('maps fields whose value is not a lone literal to null', () => {
    expect(plain(inferDefaultSchema('{ a: 1 + 2, b: [1].length, c: max(1, 2), d: null, e: "x" }'))).toEqual({
      a: null, b: null, c: null, d: null, e: 'string',
    });
  });

  it.each([
    ['{ ...base, a: 1 }'],
    ['{ a: 1, ...base }'],
    ['{ [key]: 1, a: 1 }'],
    ['{ a, b: 1 }'],
    ['{ get a() { return 1 }, b: 1 }'],
    ['{ f() { return 1 }, b: 1 }'],
    ['{ __proto__: { a: 1 }, b: 1 }'],
    ['{ "__proto__": { a: 1 }, b: 1 }'],
    ['{ "a\\u0062": 1 }'],
    ['{ 01: 1 }'],
    ['{ 1.5: 1 }'],
  ])('leaves the fields of %s unknown', expr => {
    const schema = inferDefaultSchema(expr);
    expect(schema).toEqual({ type: 'object' });
  });

  it.each([
    [''],
    ['null'],
    ['undefined'],
    ['0x10'],
    ['5n'],
    ['"a" + "b"'],
    ['`a${1}`'],
    ['[1].length'],
    ['{a: 1}.a'],
    ['"abc".length'],
    ['new Date()'],
    ['Math.max(1, 2)'],
    ['1, "a"'],
    ['5 // five'],
    ['5;'],
    ['{ a: 10 / 2 }'],
    ['{ a: /x/ }'],
    ['{ a: `${x}` }'],
    ['{ a: 1'],
    ['"open'],
    ['[1, 2'],
    ['{ a: 1 } }'],
  ])('does not guess the type of %s', expr => {
    expect(inferDefaultSchema(expr)).toBeUndefined();
  });
});

describe('findPrimitiveFieldAccess', () => {
  const schema = inferDefaultSchema('{ hp: 1, name: "x", inv: [], s: { ok: true }, u: f() }')!;

  it.each([
    [['hp', 'max'], { index: 1, type: 'number' }],
    [['name', 'length'], { index: 1, type: 'string' }],
    [['s', 'ok', 'x', 'y'], { index: 2, type: 'boolean' }],
  ])('rejects %j like Spindle', (path, expected) => {
    expect(findPrimitiveFieldAccess(schema, path)).toEqual(expected);
  });

  it.each([
    [[]],
    [['hp']],
    [['missing', 'deep']],
    [['inv', 'anything', 'deeper']],
    [['s', 'missing', 'x']],
    [['u', 'x', 'y']],
  ])('accepts %j like Spindle', path => {
    expect(findPrimitiveFieldAccess(schema, path)).toBeUndefined();
  });

  it('rejects any field on a primitive root', () => {
    expect(findPrimitiveFieldAccess({ type: 'string' }, ['length'])).toEqual({ index: 0, type: 'string' });
  });

  it('accepts anything on an object whose fields are unknown', () => {
    expect(findPrimitiveFieldAccess({ type: 'object' }, ['a', 'b'])).toBeUndefined();
  });
});
