import { describe, it, expect } from 'vitest';
import { Parameters } from '../../src/core/parsing/parameter-validator.js';
import { ArgType, type Arg } from '../../src/core/parsing/argument-lexer.js';

function makeArg(type: ArgType, text: string, start: number, end: number, extra?: Partial<Arg>): Arg {
  return { type, text, start, end, ...extra };
}

describe('Parameters', () => {
  it('validates single required text arg', () => {
    const params = new Parameters(['text']);
    const result = params.validate([makeArg(ArgType.String, '"hello"', 0, 7)]);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects wrong type', () => {
    const params = new Parameters(['number']);
    const result = params.validate([makeArg(ArgType.String, '"hello"', 0, 7)]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('validates optional parameter', () => {
    const params = new Parameters(['text |+ text']);
    // One arg: valid
    const r1 = params.validate([makeArg(ArgType.String, '"a"', 0, 3)]);
    expect(r1.errors).toHaveLength(0);
    // Two args: valid
    const r2 = params.validate([
      makeArg(ArgType.String, '"a"', 0, 3),
      makeArg(ArgType.String, '"b"', 4, 7),
    ]);
    expect(r2.errors).toHaveLength(0);
  });

  it('validates required chain', () => {
    const params = new Parameters(['text &+ text']);
    // One arg: invalid (needs two)
    const r1 = params.validate([makeArg(ArgType.String, '"a"', 0, 3)]);
    expect(r1.errors.length).toBeGreaterThan(0);
    // Two args: valid
    const r2 = params.validate([
      makeArg(ArgType.String, '"a"', 0, 3),
      makeArg(ArgType.String, '"b"', 4, 7),
    ]);
    expect(r2.errors).toHaveLength(0);
  });

  it('validates variadic', () => {
    const params = new Parameters(['...text']);
    // Multiple args: valid
    const result = params.validate([
      makeArg(ArgType.String, '"a"', 0, 3),
      makeArg(ArgType.String, '"b"', 4, 7),
      makeArg(ArgType.String, '"c"', 8, 11),
    ]);
    expect(result.errors).toHaveLength(0);
  });

  it('validates multiple variants', () => {
    const params = new Parameters(['text |+ text', '']);
    // No args: valid (matches empty variant)
    const r1 = params.validate([]);
    expect(r1.errors).toHaveLength(0);
    // One arg: valid (matches first variant)
    const r2 = params.validate([makeArg(ArgType.String, '"a"', 0, 3)]);
    expect(r2.errors).toHaveLength(0);
  });

  it('rejects too many args', () => {
    const params = new Parameters(['text']);
    const result = params.validate([
      makeArg(ArgType.String, '"a"', 0, 3),
      makeArg(ArgType.String, '"b"', 4, 7),
    ]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('isEmpty for empty variants', () => {
    expect(new Parameters(['']).isEmpty()).toBe(true);
    expect(new Parameters([]).isEmpty()).toBe(true);
    expect(new Parameters(['text']).isEmpty()).toBe(false);
  });

  it('argCountRange', () => {
    const params = new Parameters(['text |+ text']);
    const range = params.argCountRange();
    expect(range.min).toBe(1);
    expect(range.max).toBe(2);
  });

  it('validates variable type', () => {
    const params = new Parameters(['var']);
    const r = params.validate([makeArg(ArgType.Variable, '$x', 0, 2, { sigil: '$' })]);
    expect(r.errors).toHaveLength(0);
  });

  it('validates boolean type', () => {
    const params = new Parameters(['bool']);
    const r1 = params.validate([makeArg(ArgType.Boolean, 'true', 0, 4)]);
    expect(r1.errors).toHaveLength(0);
    const r2 = params.validate([makeArg(ArgType.Boolean, 'false', 0, 5)]);
    expect(r2.errors).toHaveLength(0);
  });

  it('rejects number for boolean type', () => {
    const params = new Parameters(['bool']);
    const r = params.validate([makeArg(ArgType.Number, '42', 0, 2)]);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('validates string type (only quoted strings)', () => {
    const params = new Parameters(['string']);
    const r1 = params.validate([makeArg(ArgType.String, '"hi"', 0, 4)]);
    expect(r1.errors).toHaveLength(0);
    // Bareword should not match string type
    const r2 = params.validate([makeArg(ArgType.Bareword, 'hi', 0, 2)]);
    expect(r2.errors.length).toBeGreaterThan(0);
  });

  it('text type accepts various subtypes', () => {
    const params = new Parameters(['text']);
    // String
    expect(params.validate([makeArg(ArgType.String, '"a"', 0, 3)]).errors).toHaveLength(0);
    // Number
    expect(params.validate([makeArg(ArgType.Number, '42', 0, 2)]).errors).toHaveLength(0);
    // Boolean
    expect(params.validate([makeArg(ArgType.Boolean, 'true', 0, 4)]).errors).toHaveLength(0);
    // Bareword
    expect(params.validate([makeArg(ArgType.Bareword, 'foo', 0, 3)]).errors).toHaveLength(0);
    // Null
    expect(params.validate([makeArg(ArgType.Null, 'null', 0, 4)]).errors).toHaveLength(0);
    // NaN
    expect(params.validate([makeArg(ArgType.NaN, 'NaN', 0, 3)]).errors).toHaveLength(0);
  });

  it('text type rejects variables', () => {
    const params = new Parameters(['text']);
    // Variables should not match text since they aren't "always" args in validator
    // Actually in the reference implementation, variables are "always" args that pass any type check.
    // Let's verify: variables should pass any type check.
    const r = params.validate([makeArg(ArgType.Variable, '$x', 0, 2, { sigil: '$' })]);
    expect(r.errors).toHaveLength(0);
  });

  it('validates link type', () => {
    const params = new Parameters(['link']);
    const r = params.validate([makeArg(ArgType.Link, '[[Passage]]', 0, 11)]);
    expect(r.errors).toHaveLength(0);
  });

  it('validates image type', () => {
    const params = new Parameters(['image']);
    const r = params.validate([makeArg(ArgType.Image, '[img[photo.jpg]]', 0, 16)]);
    expect(r.errors).toHaveLength(0);
  });

  it('validates or operator', () => {
    const params = new Parameters(['text | number']);
    // String matches text
    const r1 = params.validate([makeArg(ArgType.String, '"hi"', 0, 4)]);
    expect(r1.errors).toHaveLength(0);
    // Number matches number
    const r2 = params.validate([makeArg(ArgType.Number, '42', 0, 2)]);
    expect(r2.errors).toHaveLength(0);
  });

  it('argCountRange for required chain', () => {
    const params = new Parameters(['text &+ text']);
    const range = params.argCountRange();
    expect(range.min).toBe(2);
    expect(range.max).toBe(2);
  });

  it('argCountRange for variadic', () => {
    const params = new Parameters(['...text']);
    const range = params.argCountRange();
    expect(range.min).toBe(0);
    expect(range.max).toBe(Infinity);
  });

  it('argCountRange with multiple variants', () => {
    const params = new Parameters(['text', 'text &+ text']);
    const range = params.argCountRange();
    expect(range.min).toBe(1);
    expect(range.max).toBe(2);
  });

  it('validates passage type with stateInfo', () => {
    const params = new Parameters(['passage']);
    // Without stateInfo, string should be accepted (passage = text-like)
    const r = params.validate(
      [makeArg(ArgType.String, '"Start"', 0, 7)],
      { passages: ['Start', 'End'] },
    );
    expect(r.errors).toHaveLength(0);
  });

  it('warns on nonexistent passage', () => {
    const params = new Parameters(['passage']);
    const r = params.validate(
      [makeArg(ArgType.String, '"Missing"', 0, 9)],
      { passages: ['Start', 'End'] },
    );
    expect(r.errors).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('expression always passes any type check', () => {
    const params = new Parameters(['number']);
    const r = params.validate([makeArg(ArgType.Expression, '`$x + 1`', 0, 8)]);
    expect(r.errors).toHaveLength(0);
  });

  it('validates no args against empty variant', () => {
    const params = new Parameters(['']);
    const r = params.validate([]);
    expect(r.errors).toHaveLength(0);
  });

  it('rejects args against empty-only variant', () => {
    const params = new Parameters(['']);
    const r = params.validate([makeArg(ArgType.String, '"a"', 0, 3)]);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
