import { describe, it, expect } from 'vitest';
import { parseDeclarations, type FieldSchema } from '@rohal12/spindle/tooling';
import { findPrimitiveFieldAccess } from '../../src/core/workspace/variable-schema.js';

/** The static schema Spindle's tooling API reads from a default, as the tracker keeps it. */
function schemaOf(expr: string): FieldSchema {
  const schema = parseDeclarations(`$v = ${expr}`).declarations[0]?.schema;
  if (!schema) throw new Error(`no static schema for ${expr}`);
  return schema;
}

describe('findPrimitiveFieldAccess', () => {
  const schema = schemaOf('{ hp: 1, name: "x", inv: [], s: { ok: true }, u: f(), nil: null, "quoted key": 2 }');

  it.each([
    [['hp', 'max'], { index: 1, type: 'number' }],
    [['name', 'nope'], { index: 1, type: 'string' }],
    [['s', 'ok', 'x', 'y'], { index: 2, type: 'boolean' }],
    [['quoted key', 'nope'], { index: 1, type: 'number' }],
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
    [['nil', 'anything', 'deeper']],
  ])('accepts %j like Spindle', path => {
    expect(findPrimitiveFieldAccess(schema, path)).toEqual(undefined);
  });

  it('allows the members of the wrapper of a primitive and walks on with a primitive member', () => {
    expect(findPrimitiveFieldAccess(schema, ['name', 'length'])).toBeUndefined();
    expect(findPrimitiveFieldAccess(schema, ['name', 'length', 'toFixed'])).toBeUndefined();
    expect(findPrimitiveFieldAccess(schema, ['name', 'length', 'nope'])).toEqual({ index: 2, type: 'number' });
    // a function member ends the walk
    expect(findPrimitiveFieldAccess(schema, ['name', 'toUpperCase', 'nope'])).toBeUndefined();
    expect(findPrimitiveFieldAccess(schema, ['hp', 'toFixed', 'name'])).toBeUndefined();
  });

  it('rejects any non-member field on a primitive root', () => {
    expect(findPrimitiveFieldAccess({ type: 'string' }, ['nope'])).toEqual({ index: 0, type: 'string' });
  });

  it('accepts anything on a null default, which may later hold a value of any shape', () => {
    expect(findPrimitiveFieldAccess(schemaOf('null'), ['a', 'b'])).toBeUndefined();
  });

  it('accepts a field the object literal does not give statically', () => {
    expect(findPrimitiveFieldAccess(schemaOf('{ a: 1, ...rest, [key]: 2 }'), ['b', 'c'])).toBeUndefined();
    expect(findPrimitiveFieldAccess(schemaOf('{ a: 1, ...rest }'), ['a', 'c'])).toEqual({ index: 1, type: 'number' });
  });
});
