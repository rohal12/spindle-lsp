import type { ValueSchema, VariableValueType } from '../types.js';

export type { ValueSchema };

/** The default expression is not one this parser can follow. */
class Unparsable extends Error {}

const IDENTIFIER_RE = /[A-Za-z_$][\w$]*/y;
/** A BigInt literal, possibly negated: `-1n` is a bigint, `+1n` a TypeError. */
const BIGINT_RE = /-?(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|0|[1-9][\d_]*)n(?![\w$])/y;
const NUMBER_RE = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/y;
/**
 * A numeric property key that names itself: `2: …` is the field "2". Up to
 * 15 digits, so that it is exact as a number and converts back unchanged.
 */
const INDEX_KEY_RE = /(?:0|[1-9]\d{0,14})(?![\w$.])/y;

/**
 * A value Spindle's inferSchema() rejects ("Unsupported type …"): null,
 * undefined, a function or a bigint, as the whole default or in a field of an
 * object.
 */
export interface UnsupportedValue {
  /** The `typeof` Spindle reports: `object` for null. */
  type: 'object' | 'undefined' | 'function' | 'bigint';
  /** The value as Spindle's message prints it. */
  text: string;
  /** The object fields leading to it; empty for the whole default. */
  path: string[];
  /** Offsets of the value's source text in the expression. */
  start: number;
  end: number;
}

/** A value read by the parser: its schema, if known, and whether Spindle rejects it. */
interface Read {
  schema: ValueSchema | null;
  unsupported?: UnsupportedValue;
}

const UNKNOWN: Read = { schema: null };

/**
 * A reader of JavaScript literals: numbers, strings, booleans, arrays and
 * objects, nested. Code that is not a literal (calls, operators) is
 * skipped by bracket and string balance and typed as unknown. Anything that
 * could make that skipping unreliable (a `/`, which may start a regular
 * expression or a comment, or a `${…}` in a template) gives up on the whole
 * expression instead.
 *
 * It also recognises the values Spindle rejects, whatever the code around
 * them: `null`, `undefined`, `void 0`, function, arrow function and class
 * expressions, and BigInt literals. Their schema is unknown.
 */
class LiteralParser {
  pos = 0;

  constructor(private readonly text: string) {}

  atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  skipSpace(): void {
    while (/\s/.test(this.text[this.pos] ?? '')) this.pos++;
  }

  /** A value up to the `,` / `}` / `]` that ends it; null when its type is unknown. */
  value(): ValueSchema | null {
    return this.read().schema;
  }

  /** A value up to the `,` / `}` / `]` that ends it. */
  read(): Read {
    this.skipSpace();
    const start = this.pos;
    const read = this.literal();
    this.skipSpace();
    const next = this.text[this.pos];
    if (read && (next === undefined || next === ',' || next === '}' || next === ']')) return read;

    // An expression, possibly starting with a literal: `[1].length`, `f(1)`.
    this.pos = start;
    this.skipExpression();
    return UNKNOWN;
  }

  /** A literal, consumed; undefined when the code here is not one. */
  private literal(): Read | undefined {
    const start = this.pos;
    const ch = this.text[this.pos];
    if (ch === '{') return this.object();
    if (ch === '[') {
      this.pos++;
      this.skipList(']');
      return { schema: { type: 'array' } };
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      this.stringLiteral();
      return { schema: { type: 'string' } };
    }
    if (ch === '(') return this.functionLiteral(start);
    const word = this.match(IDENTIFIER_RE);
    if (word === 'true' || word === 'false') return { schema: { type: 'boolean' } };
    if (word === 'null') return this.unsupported('object', start);
    if (word === 'undefined') return this.unsupported('undefined', start);
    if (word === 'void') {
      this.skipSpace();
      if (this.match(NUMBER_RE) === undefined) return undefined;
      return this.unsupported('undefined', start, 'undefined');
    }
    if (word !== undefined) return this.functionLiteral(start);
    if (this.match(BIGINT_RE) !== undefined) {
      return this.unsupported('bigint', start, bigintString(this.text.slice(start, this.pos)));
    }
    if (this.match(NUMBER_RE) !== undefined) return { schema: { type: 'number' } };
    return undefined;
  }

  /** The value from `start` to here, which Spindle rejects. */
  private unsupported(type: UnsupportedValue['type'], start: number, text?: string): Read {
    const end = this.pos;
    return { schema: null, unsupported: { type, text: text ?? this.text.slice(start, end), path: [], start, end } };
  }

  /**
   * A function, arrow function or class expression at `start`, consumed;
   * undefined, with nothing consumed, for any other code.
   */
  private functionLiteral(start: number): Read | undefined {
    this.pos = start;
    try {
      if (this.functionSyntax()) return this.unsupported('function', start);
    } catch (err) {
      if (!(err instanceof Unparsable)) throw err;
    }
    this.pos = start;
    return undefined;
  }

  private functionSyntax(): boolean {
    let word = this.match(IDENTIFIER_RE);
    if (word === 'async') {
      this.skipSpace();
      word = this.match(IDENTIFIER_RE);
    }
    this.skipSpace();
    if (word === 'function') {
      if (this.text[this.pos] === '*') this.pos++;
      this.skipSpace();
      this.match(IDENTIFIER_RE);
      this.skipSpace();
      if (!this.skipBracketed('(', ')')) return false;
      this.skipSpace();
      return this.skipBracketed('{', '}');
    }
    if (word === 'class') {
      if (this.match(IDENTIFIER_RE) !== undefined) this.skipSpace();
      return this.skipBracketed('{', '}');
    }
    // An arrow function, `x => …` or `(…) => …`, whose body runs to the
    // `,` / `}` / `]` that ends the value.
    if (word === undefined && !this.skipBracketed('(', ')')) return false;
    this.skipSpace();
    if (!this.text.startsWith('=>', this.pos)) return false;
    this.pos += 2;
    this.skipSpace();
    if (this.text[this.pos] === '{') return this.skipBracketed('{', '}');
    const bodyStart = this.pos;
    this.skipExpression();
    while (this.pos > bodyStart && /\s/.test(this.text[this.pos - 1])) this.pos--;
    return this.pos > bodyStart;
  }

  /** Skip a bracketed list that opens here; false if none does. */
  private skipBracketed(open: string, close: string): boolean {
    if (this.text[this.pos] !== open) return false;
    this.pos++;
    this.skipList(close);
    return true;
  }

  private object(): Read {
    this.pos++; // {
    let fields: Map<string, ValueSchema | null> | undefined = new Map();
    const unsupported = new Map<string, UnsupportedValue>();
    for (;;) {
      this.skipSpace();
      if (this.text[this.pos] === '}') {
        this.pos++;
        break;
      }
      const key = this.propertyKey();
      this.skipSpace();
      if (key !== undefined && key !== '__proto__' && this.text[this.pos] === ':') {
        this.pos++;
        const read = this.read();
        fields?.set(key, read.schema);
        // A later field of the same name replaces the value.
        unsupported.delete(key);
        if (read.unsupported) {
          unsupported.set(key, { ...read.unsupported, path: [key, ...read.unsupported.path] });
        }
      } else {
        // A spread, computed key, shorthand, method, accessor or prototype:
        // the object's own fields are not what its literal keys say.
        fields = undefined;
        this.skipExpression();
      }
      this.skipSpace();
      const sep = this.text[this.pos++];
      if (sep === '}') break;
      if (sep !== ',') throw new Unparsable();
    }
    if (!fields) return { schema: { type: 'object' } };
    const [first] = unsupported.values();
    return { schema: { type: 'object', fields }, unsupported: first };
  }

  /** A plain property key, consumed; undefined (possibly consumed) for any other. */
  private propertyKey(): string | undefined {
    const ch = this.text[this.pos];
    if (ch === '"' || ch === "'") {
      const raw = this.stringLiteral();
      return raw.includes('\\') ? undefined : raw;
    }
    return this.match(IDENTIFIER_RE) ?? this.match(INDEX_KEY_RE);
  }

  /** Consume a string or template literal and return its raw text. */
  private stringLiteral(): string {
    const quote = this.text[this.pos];
    const start = ++this.pos;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === '\\') {
        this.pos += 2;
        continue;
      }
      if (quote === '`' && ch === '$' && this.text[this.pos + 1] === '{') throw new Unparsable();
      if (ch === quote) return this.text.slice(start, this.pos++);
      this.pos++;
    }
    throw new Unparsable();
  }

  /** Skip comma-separated expressions up to and including `close`. */
  private skipList(close: string): void {
    for (;;) {
      this.skipExpression();
      const ch = this.text[this.pos++];
      if (ch === close) return;
      if (ch !== ',') throw new Unparsable();
    }
  }

  /** Skip code up to a `,`, `)`, `]` or `}` that closes nothing, or the end. */
  private skipExpression(): void {
    let depth = 0;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === '"' || ch === "'" || ch === '`') {
        this.stringLiteral();
        continue;
      }
      if (ch === '/') throw new Unparsable();
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) return;
        depth--;
      } else if (ch === ',' && depth === 0) return;
      this.pos++;
    }
    if (depth > 0) throw new Unparsable();
  }

  private match(re: RegExp): string | undefined {
    re.lastIndex = this.pos;
    const m = re.exec(this.text);
    if (!m) return undefined;
    this.pos += m[0].length;
    return m[0];
  }
}

/**
 * The schema Spindle infers for a StoryVariables default, read from the
 * expression text without evaluating it. Returns undefined unless the whole
 * expression is a single literal: `2 * 3`, `"a" + "b"` or `new Date()` have
 * a type only once evaluated, so no type is guessed for them.
 */
export function inferDefaultSchema(expr: string): ValueSchema | undefined {
  const parser = new LiteralParser(expr.trim());
  try {
    const schema = parser.value();
    parser.skipSpace();
    return schema && parser.atEnd() ? schema : undefined;
  } catch (err) {
    if (err instanceof Unparsable) return undefined;
    throw err;
  }
}

/**
 * The value of a StoryVariables default that Spindle's inferSchema() rejects,
 * read from the expression text without evaluating it: the whole default, or
 * a field of an object literal (Spindle does not look inside arrays). Returns
 * undefined unless the expression is a single literal and the rejected value
 * is certain. Offsets are relative to `expr`.
 */
export function findUnsupportedValue(expr: string): UnsupportedValue | undefined {
  const offset = expr.length - expr.trimStart().length;
  const parser = new LiteralParser(expr.trim());
  try {
    const read = parser.read();
    parser.skipSpace();
    const value = read.unsupported;
    if (!parser.atEnd() || !value) return undefined;
    return { ...value, start: value.start + offset, end: value.end + offset };
  } catch (err) {
    if (err instanceof Unparsable) return undefined;
    throw err;
  }
}

/** A BigInt literal as Spindle's message prints the value: String(value). */
function bigintString(literal: string): string {
  const digits = literal.slice(0, -1).replace(/_/g, '');
  const negative = digits.startsWith('-');
  try {
    const value = BigInt(negative ? digits.slice(1) : digits);
    return String(negative ? -value : value);
  } catch {
    return digits;
  }
}

/**
 * Boxed sample values whose members a primitive of each type can access, as
 * in Spindle's validateRef() from 0.51.1: `part in sample` and the `typeof`
 * of the member decide how the walk continues.
 */
const PRIMITIVE_SAMPLES: Partial<Record<VariableValueType, object>> = {
  string: Object(''),
  number: Object(0),
  boolean: Object(false),
};

/**
 * Walk `fields` (a path below a variable) through its schema as Spindle's
 * validateRef() does, and return the first field it rejects: one accessed on
 * a number, string or boolean. Spindle allows any field of an array and any
 * field an object's default does not have, so the walk stops there, and it
 * stops wherever the schema does not know a type. With `primitiveMembers`
 * (Spindle >= 0.51.1), a member of the primitive's wrapper (`length`,
 * `toFixed`, ...) is allowed: the walk continues with the member's type when
 * that is a number, string or boolean, and stops for any other member.
 */
export function findPrimitiveFieldAccess(
  schema: ValueSchema,
  fields: string[],
  primitiveMembers = false,
): { index: number; type: VariableValueType } | undefined {
  let current = schema;
  for (let i = 0; i < fields.length; i++) {
    if (current.type === 'array') return undefined;
    const sample = primitiveMembers ? PRIMITIVE_SAMPLES[current.type] : undefined;
    if (sample && fields[i] in sample) {
      const memberType = typeof sample[fields[i] as keyof typeof sample];
      if (memberType !== 'number' && memberType !== 'string' && memberType !== 'boolean') return undefined;
      current = { type: memberType };
      continue;
    }
    if (current.type !== 'object') return { index: i, type: current.type };
    const next = current.fields?.get(fields[i]);
    if (!next) return undefined;
    current = next;
  }
  return undefined;
}
