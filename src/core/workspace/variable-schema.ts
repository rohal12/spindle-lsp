import type { ValueSchema, VariableValueType } from '../types.js';

export type { ValueSchema };

/** The default expression is not one this parser can follow. */
class Unparsable extends Error {}

const IDENTIFIER_RE = /[A-Za-z_$][\w$]*/y;
const NUMBER_RE = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/y;
/**
 * A numeric property key that names itself: `2: …` is the field "2". Up to
 * 15 digits, so that it is exact as a number and converts back unchanged.
 */
const INDEX_KEY_RE = /(?:0|[1-9]\d{0,14})(?![\w$.])/y;

/**
 * A reader of JavaScript literals: numbers, strings, booleans, arrays and
 * objects, nested. Code that is not a literal (calls, operators, `null`) is
 * skipped by bracket and string balance and typed as unknown. Anything that
 * could make that skipping unreliable (a `/`, which may start a regular
 * expression or a comment, or a `${…}` in a template) gives up on the whole
 * expression instead.
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
    this.skipSpace();
    const start = this.pos;
    const schema = this.literal();
    this.skipSpace();
    const next = this.text[this.pos];
    if (schema && (next === undefined || next === ',' || next === '}' || next === ']')) return schema;

    // An expression, possibly starting with a literal: `[1].length`, `f(1)`.
    this.pos = start;
    this.skipExpression();
    return null;
  }

  private literal(): ValueSchema | null {
    const ch = this.text[this.pos];
    if (ch === '{') return this.object();
    if (ch === '[') {
      this.pos++;
      this.skipList(']');
      return { type: 'array' };
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      this.stringLiteral();
      return { type: 'string' };
    }
    const word = this.match(IDENTIFIER_RE);
    if (word === 'true' || word === 'false') return { type: 'boolean' };
    if (word !== undefined) return null;
    if (this.match(NUMBER_RE) !== undefined) return { type: 'number' };
    return null;
  }

  private object(): ValueSchema {
    this.pos++; // {
    let fields: Map<string, ValueSchema | null> | undefined = new Map();
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
        const schema = this.value();
        fields?.set(key, schema);
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
    return fields ? { type: 'object', fields } : { type: 'object' };
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
 * Walk `fields` (a path below a variable) through its schema as Spindle's
 * validateRef() does, and return the first field it rejects: one accessed on
 * a number, string or boolean. Spindle allows any field of an array and any
 * field an object's default does not have, so the walk stops there, and it
 * stops wherever the schema does not know a type.
 */
export function findPrimitiveFieldAccess(
  schema: ValueSchema,
  fields: string[],
): { index: number; type: VariableValueType } | undefined {
  let current = schema;
  for (let i = 0; i < fields.length; i++) {
    if (current.type === 'array') return undefined;
    if (current.type !== 'object') return { index: i, type: current.type };
    const next = current.fields?.get(fields[i]);
    if (!next) return undefined;
    current = next;
  }
  return undefined;
}
