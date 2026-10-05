// Vendored from @rohal12/spindle 0.51.3 (Unlicense): src/story-variables.ts and
// src/markup/tokenizer.ts, unchanged except for these imports. The always-on
// oracle for the startup validation that scans executable references only
// (>= 0.50.1; identical through 0.51.3), so the contract is checked whichever
// Spindle is installed. scripts/peer-matrix.sh checks the installed runtimes.
import { tokenize } from './tokenizer';

interface Passage {
  name: string;
  tags: string[];
  content: string;
}

export type VarType = 'number' | 'string' | 'boolean' | 'array' | 'object';

export interface FieldSchema {
  type: VarType;
  fields?: Map<string, FieldSchema>; // only for objects
}

export interface VariableSchema extends FieldSchema {
  name: string;
  default: unknown;
}

function declarationRegex(sigil: string): RegExp {
  const escaped = sigil.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(\\w+)\\s*=\\s*(.+)$`);
}
const VAR_REF_RE = /\$(\w+(?:\.\w+)*)/g;
/** `{` followed by a sigil starts an interpolation block inside literal text. */
const INTERP_START_RE = /^[$_@%]\w/;
/** Quoted first argument of an input macro naming a story variable. */
const QUOTED_VAR_ARG_RE = /^["']\$(\w+(?:\.\w+)*)["']?$/;
const FOR_LOCAL_RE = /\{for\s+@(\w+)(?:\s*,\s*@(\w+))?\s+of\b/g;

const VALID_VAR_TYPES = new Set<string>(['number', 'string', 'boolean']);

/** Boxed sample values whose members a primitive of each type can access. */
const PRIMITIVE_SAMPLES: Partial<Record<VarType, object>> = {
  string: Object(''),
  number: Object(0),
  boolean: Object(false),
};

function inferSchema(value: unknown): FieldSchema {
  if (Array.isArray(value)) {
    return { type: 'array' };
  }
  if (value !== null && typeof value === 'object') {
    const fields = new Map<string, FieldSchema>();
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      fields.set(key, inferSchema(val));
    }
    return { type: 'object', fields };
  }
  const jsType = typeof value;
  if (!VALID_VAR_TYPES.has(jsType)) {
    throw new Error(
      `Unsupported type "${jsType}" for value ${String(value)}. Expected number, string, boolean, array, or object.`,
    );
  }
  return { type: jsType as VarType };
}

/**
 * Parse a StoryVariables or StoryTransients passage content into a schema map.
 * Each line: `$varName = expression` (or `%varName = expression` for transients)
 */
export function parseStoryVariables(
  content: string,
  sigil: '$' | '%' = '$',
): Map<string, VariableSchema> {
  const schema = new Map<string, VariableSchema>();
  const DECLARATION_RE = declarationRegex(sigil);
  const passageName = sigil === '%' ? 'StoryTransients' : 'StoryVariables';

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(DECLARATION_RE);
    if (!match) {
      throw new Error(
        `${passageName}: Invalid declaration: "${line}". Expected: ${sigil}name = value`,
      );
    }

    const [, name, expr] = match as [string, string, string];
    let value: unknown;
    try {
      value = new Function('return (' + expr + ')')();
    } catch (err) {
      throw new Error(
        `${passageName}: Failed to evaluate "${sigil}${name} = ${expr}": ${err instanceof Error ? err.message : err}`,
      );
    }

    let fieldSchema: FieldSchema;
    try {
      fieldSchema = inferSchema(value);
    } catch (err) {
      throw new Error(
        `${passageName}: ${err instanceof Error ? err.message : err}`,
      );
    }
    schema.set(name, { ...fieldSchema, name, default: value });
  }

  return schema;
}

/**
 * Extract for-loop local variable names from passage content.
 * `{for @item of ...}` → "item"
 * `{for @index, @item of ...}` → "index", "item"
 */
function extractForLocals(content: string): Set<string> {
  const locals = new Set<string>();
  let match: RegExpExecArray | null;
  FOR_LOCAL_RE.lastIndex = 0;
  while ((match = FOR_LOCAL_RE.exec(content)) !== null) {
    locals.add(match[1]!);
    if (match[2]) locals.add(match[2]!);
  }
  return locals;
}

/**
 * Validate a single variable reference path (e.g. "player.health") against
 * the schema. Returns an error message or null if valid.
 */
function validateRef(
  ref: string,
  schema: Map<string, VariableSchema>,
  forLocals: Set<string>,
): string | null {
  const parts = ref.split('.');
  const rootName = parts[0]!;

  // Skip for-loop locals
  if (forLocals.has(rootName)) return null;

  const rootSchema = schema.get(rootName);
  if (!rootSchema) {
    return `Undeclared variable: $${ref}`;
  }

  // Walk through field access path
  let current: FieldSchema = rootSchema;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i] as string;

    // Arrays have built-in methods/properties (push, find, length, etc.)
    // so any field access on an array is allowed.
    if (current.type === 'array') return null;

    // Primitives expose their wrapper's built-ins (length, toUpperCase,
    // toFixed, etc.). Keep validating past properties of primitive type.
    const sample = PRIMITIVE_SAMPLES[current.type];
    if (sample && part in sample) {
      const member: unknown = sample[part as keyof typeof sample];
      const memberType = typeof member;
      if (!VALID_VAR_TYPES.has(memberType)) return null;
      current = { type: memberType as VarType };
      continue;
    }

    if (current.type !== 'object' || !current.fields) {
      return `Cannot access field "${part}" on $${parts.slice(0, i).join('.')} (type: ${current.type})`;
    }
    const fieldSchema = current.fields.get(part);
    if (!fieldSchema) {
      // Unknown fields on objects are allowed — classes registered via
      // Story.registerClass() can add methods/getters not in the defaults.
      return null;
    }
    current = fieldSchema;
  }

  return null;
}

/**
 * Built-in input macros whose first argument names the bound story variable,
 * quoted or not (e.g. `{textbox "$name"}`).
 */
const BUILTIN_STORE_VAR_MACROS: readonly string[] = [
  'checkbox',
  'cycle',
  'listbox',
  'numberbox',
  'radiobutton',
  'textarea',
  'textbox',
];

type RefCallback = (ref: string) => void;

/** Report every `$var.path` in a code segment free of strings/comments. */
function scanRefs(segment: string, onRef: RefCallback): void {
  for (const match of segment.matchAll(VAR_REF_RE)) onRef(match[1]!);
}

/** Index of the quote closing the string opened at `start` (or the end). */
function findClosingQuote(code: string, start: number): number {
  const quote = code[start];
  let i = start + 1;
  while (i < code.length && code[i] !== quote) {
    i += code[i] === '\\' ? 2 : 1;
  }
  return Math.min(i, code.length);
}

/**
 * Scan literal text (string contents, HTML attribute values) for `{$…}`
 * interpolation blocks, which interpolating macros and HTML attributes
 * resolve at runtime. A bare `$word` in literal text is not a reference.
 */
function scanInterpolations(text: string, onRef: RefCallback): void {
  let i = text.indexOf('{');
  while (i !== -1) {
    const next = INTERP_START_RE.test(text.slice(i + 1, i + 3))
      ? scanCode(text, i + 1, onRef, true)
      : i + 1;
    i = text.indexOf('{', next);
  }
}

/**
 * Scan a template literal starting just after its opening backtick: literal
 * parts are text, `${…}` parts are code. Returns the index just past the
 * closing backtick.
 */
function scanTemplate(code: string, start: number, onRef: RefCallback): number {
  let i = start;
  let textStart = start;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\') {
      i += 2;
    } else if (ch === '`') {
      scanInterpolations(code.slice(textStart, i), onRef);
      return i + 1;
    } else if (ch === '$' && code[i + 1] === '{') {
      scanInterpolations(code.slice(textStart, i), onRef);
      i = textStart = scanCode(code, i + 2, onRef, true);
    } else {
      i++;
    }
  }
  scanInterpolations(code.slice(textStart), onRef);
  return code.length;
}

/**
 * Report `$var` references in JavaScript code. Like the string-aware
 * expression transformer, sigils inside string literals are left alone while
 * template-literal `${…}` parts are code; comments are skipped too. When
 * `nested`, stops at the `}` closing the enclosing block and returns the index
 * just past it.
 */
function scanCode(
  code: string,
  start: number,
  onRef: RefCallback,
  nested = false,
): number {
  let i = start;
  let segStart = start;
  let depth = 0;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    const isComment = ch === '/' && (next === '/' || next === '*');
    if (ch === '"' || ch === "'" || ch === '`' || isComment) {
      scanRefs(code.slice(segStart, i), onRef);
      if (ch === '`') {
        i = scanTemplate(code, i + 1, onRef);
      } else if (isComment) {
        const close = code.indexOf(next === '/' ? '\n' : '*/', i + 2);
        i = close === -1 ? code.length : next === '/' ? close : close + 2;
      } else {
        const close = findClosingQuote(code, i);
        scanInterpolations(code.slice(i + 1, close), onRef);
        i = Math.min(close + 1, code.length);
      }
      segStart = i;
      continue;
    }
    if (nested && ch === '{') {
      depth++;
    } else if (nested && ch === '}' && depth-- === 0) {
      scanRefs(code.slice(segStart, i), onRef);
      return i + 1;
    }
    i++;
  }
  scanRefs(code.slice(segStart), onRef);
  return code.length;
}

/**
 * Report the `$var` references a passage evaluates at runtime: `{$var}`
 * displays, `{$expr}` expressions, macro arguments and `{do}` bodies (as
 * code), quoted variable names bound by input macros, and `{$…}`
 * interpolations in HTML attributes. Prose is literal text and not scanned.
 */
function collectPassageRefs(
  content: string,
  storeVarMacros: ReadonlySet<string>,
  onRef: RefCallback,
): void {
  const tokens = tokenize(content);
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]!;
    if (token.type === 'variable') {
      if (token.scope === 'variable' && token.name) onRef(token.name);
    } else if (token.type === 'expression') {
      scanCode(token.expression, 0, onRef);
    } else if (token.type === 'html') {
      for (const value of Object.values(token.attributes)) {
        scanInterpolations(value, onRef);
      }
    } else if (token.type === 'macro' && !token.isClose) {
      scanCode(token.rawArgs, 0, onRef);

      if (storeVarMacros.has(token.name.toLowerCase())) {
        const first = token.rawArgs.trim().split(/\s+/)[0] ?? '';
        const quoted = QUOTED_VAR_ARG_RE.exec(first);
        if (quoted) onRef(quoted[1]!);
      }

      if (token.name === 'do') {
        // A {do} body is JavaScript: scan its source text as code, however
        // the markup tokenizer split it up.
        let close = t + 1;
        while (close < tokens.length) {
          const c = tokens[close]!;
          if (c.type === 'macro' && c.isClose && c.name === 'do') break;
          close++;
        }
        if (close < tokens.length) {
          scanCode(content.slice(token.end, tokens[close]!.start), 0, onRef);
          t = close;
        }
      }
    }
  }
}

/**
 * Scan all passages for $var references, check against schema.
 * Returns list of error messages (empty = valid).
 *
 * `storeVarMacros` lists the input macros whose first argument names a bound
 * variable; it defaults to the built-in ones.
 */
export function validatePassages(
  passages: Map<string, Passage>,
  schema: Map<string, VariableSchema>,
  storeVarMacros: Iterable<string> = BUILTIN_STORE_VAR_MACROS,
): string[] {
  const errors: string[] = [];
  const storeVarSet = new Set(
    Array.from(storeVarMacros, (m) => m.toLowerCase()),
  );

  for (const [name, passage] of passages) {
    // Don't validate the StoryVariables/StoryTransients passages themselves
    if (name === 'StoryVariables' || name === 'StoryTransients') continue;

    const forLocals = extractForLocals(passage.content);

    collectPassageRefs(passage.content, storeVarSet, (ref) => {
      const error = validateRef(ref, schema, forLocals);
      if (error) {
        errors.push(`Passage "${name}": ${error}`);
      }
    });
  }

  return errors;
}

/**
 * Extract default values from the schema as a plain object.
 */
export function extractDefaults(
  schema: Map<string, VariableSchema>,
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [name, varSchema] of schema) {
    defaults[name] = varSchema.default;
  }
  return defaults;
}
