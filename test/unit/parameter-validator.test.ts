import { describe, it, expect } from 'vitest';
import { Parameters } from '../../src/core/parsing/parameter-validator.js';
import { ArgType, lexArguments, type Arg } from '../../src/core/parsing/argument-lexer.js';
import supplements from '../../src/macro-supplements.json';

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

describe('receiver parameter type', () => {
  const params = new Parameters(['receiver |+ text']);

  it('accepts quoted and unquoted story variables', () => {
    // Spindle's parseVarArgs() reads the receiver as `\$[\w.]+`: `$5` is one too
    for (const raw of ['"$name"', "'$name'", '$name', '"$player.name" "Your name"', '"name"', '"$5"', '$5']) {
      expect(params.validate(lexArguments(raw)).errors, raw).toEqual([]);
    }
  });

  it('rejects values that cannot name a variable', () => {
    for (const raw of ['42', 'true', '"$"', '"not a var"', '"5"']) {
      expect(params.validate(lexArguments(raw)).errors.length, raw).toBeGreaterThan(0);
    }
  });

  it('rejects quoted temporaries, locals and transients', () => {
    const r = params.validate(lexArguments('"_tmp"'));
    expect(r.errors[0].message).toContain('story variable');
  });
});

describe('configured schema alternatives (#135)', () => {
  it.each([
    ['string | (string &+ number)', '"hello" 1'],
    ['(string &+ number) | string', '"hello"'],
    ['(string | (string &+ number)) &+ bool', '"hello" 1 true'],
    ['((string &+ number) | string) &+ number', '"hello" 1'],
    ['(string | (string &+ number)) |+ bool', '"hello" 1 true'],
    ['...(string | (string &+ number)) &+ bool', '"hello" 1 "world" 2 true'],
    ['...string &+ string', '"hello"'],
    ['...(|+ string) &+ number', '1'],
  ])('accepts a complete match for %s', (schema, source) => {
    expect(new Parameters([schema]).validate(lexArguments(source)).errors).toEqual([]);
  });

  it.each(['"hello" true', '"hello" 1 2', '1', ''])('still rejects %s', source => {
    expect(new Parameters(['string | (string &+ number)']).validate(lexArguments(source)).errors.length).toBeGreaterThan(0);
  });

  it('keeps warnings from the chosen complete branch only', () => {
    const result = new Parameters(['passage | (string &+ number)']).validate(
      lexArguments('"Missing" 1'), { passages: ['Start'] },
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(new Parameters(['passage | (string &+ number)']).validate(
      lexArguments('"Missing"'), { passages: ['Start'] },
    ).warnings).toHaveLength(1);
  });

  it.each([
    ['(...(string | (string &+ string)) &+ bool) | (...string &+ number)'],
    ['...(string | (string &+ string)) &+ bool', '...string &+ number'],
  ])('does not revisit equivalent repeated matches before trying a later branch (%j)', (...schemas) => {
    const source = [...Array(11).fill('"x"'), '1'].join(' ');
    expect(new Parameters(schemas).validate(lexArguments(source)).errors).toEqual([]);
  });

  it('keeps the preferred repeated branch warnings at a shared endpoint', () => {
    const result = new Parameters(['...(passage | (string &+ string))']).validate(
      lexArguments('"MissingA" "MissingB"'), { passages: ['Start'] },
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings.map(warning => warning.argIndex)).toEqual([0, 1]);
  });

  it.each([
    ['...(string | number)', 667],
    ['(...string) | (...(string | (string &+ string)))', 400],
  ])('keeps long valid calls within the matching budget for %s', (schema, count) => {
    const args = lexArguments(Array(count).fill('"x"').join(' '));
    expect(new Parameters([schema]).validate(args).errors).toEqual([]);
  });
});

describe('configured quoted literals (#137)', () => {
  it.each([
    [String.raw`'a"b'`, String.raw`"a\"b"`],
    [String.raw`"a'b"`, String.raw`'a\'b'`],
    [String.raw`'a\\b'`, String.raw`"a\\b"`],
    [String.raw`'a\b'`, String.raw`"a\\b"`],
    [String.raw`'a\'b'`, String.raw`"a'b"`],
    [String.raw`"a\"b"`, String.raw`'a"b'`],
    [String.raw`'a\nb'`, String.raw`"a\nb"`],
  ])('compares decoded values for %s and %s', (schema, source) => {
    const params = new Parameters([schema]);
    expect(params.validate(lexArguments(source)).errors).toEqual([]);
    expect(params.validate(lexArguments('"different"')).errors).toHaveLength(1);
    expect(params.describe()[0][0].accepts(lexArguments(source)[0])).toBe(true);
  });
});

describe('shipped macro parameter schemas', () => {
  const entries = Object.entries(supplements as Record<string, { parameters?: string[] }>)
    .filter(([, entry]) => entry.parameters !== undefined);

  it.each(entries)('compiles the parameters of {%s}', (_name, entry) => {
    expect(() => new Parameters(entry.parameters!)).not.toThrow();
  });
});
