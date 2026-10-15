import { describe, expect, it } from 'vitest';

import { toJsonSafe } from '../../src/mcp/play/json-safe.js';

describe('toJsonSafe', () => {
  it('keeps plain JSON data as it is', () => {
    const data = { a: 1, b: 'x', c: [true, null], d: { e: 2 } };
    expect(toJsonSafe(data)).toEqual(data);
  });

  it('renders a Map as an object of its entries', () => {
    const key = { id: 1 };
    const map = new Map<unknown, unknown>([['sword', 1], [2, 'two'], [key, 'obj']]);
    expect(toJsonSafe(map)).toEqual({ sword: 1, '2': 'two', '{"id":1}': 'obj' });
  });

  it('renders a Set and a typed array as arrays', () => {
    expect(toJsonSafe(new Set(['a', new Set([1])]))).toEqual(['a', [1]]);
    expect(toJsonSafe(new Uint8Array([1, 2]))).toEqual([1, 2]);
  });

  it('renders a Date as an ISO string', () => {
    expect(toJsonSafe(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
    expect(toJsonSafe(new Date(Number.NaN))).toBe('Invalid Date');
  });

  it('renders numbers JSON cannot hold, bigints and regexps as strings', () => {
    expect(toJsonSafe([Number.NaN, Infinity, 10n, /a+/g])).toEqual(['NaN', 'Infinity', '10', '/a+/g']);
  });

  it('marks a cycle but repeats a shared value', () => {
    const shared = { n: 1 };
    const node: Record<string, unknown> = { shared, again: shared };
    node.self = node;
    expect(toJsonSafe(node)).toEqual({ shared: { n: 1 }, again: { n: 1 }, self: '[circular]' });
  });

  it('leaves out undefined properties and nulls undefined array items, as JSON does', () => {
    expect(toJsonSafe({ a: undefined, b: [undefined] })).toEqual({ b: [null] });
  });

  it('round-trips through JSON.stringify unchanged', () => {
    const value = toJsonSafe({ m: new Map([['k', new Set([new Date(0)])]]) });
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });
});
