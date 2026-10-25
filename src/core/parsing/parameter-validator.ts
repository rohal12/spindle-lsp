/**
 * Variant-based parameter validation for Spindle macros.
 *
 * Ported from twee3-language-tools/src/spindle-0/parameters.ts with simplifications:
 *   - No dependency on vscode types
 *   - Uses the simplified ArgType enum from argument-lexer.ts
 *   - Pratt-parser format string parser preserved for correct operator precedence
 *
 * Format syntax:
 *   type           — single required parameter (e.g. "text", "number", "var")
 *   ...type        — variadic (zero or more)
 *   type |+ type   — optional next (left required, right optional)
 *   type &+ type   — required chain (both required)
 *   type | type    — or (either left or right)
 *   'literal'      — literal value match
 *   (group)        — grouping
 */

import { passageTarget, readQuoted, parseBoundVariable } from '@rohal12/spindle/tooling';
import { ArgType, type Arg } from './argument-lexer.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  variantIndex: number | null;
  errors: ArgumentError[];
  warnings: ArgumentWarning[];
}

export interface ArgumentError {
  message: string;
  argIndex: number;
}

export interface ArgumentWarning {
  message: string;
  argIndex: number;
}

export interface StateInfo {
  passages: string[];
}

// ---------------------------------------------------------------------------
// Parameter type system
// ---------------------------------------------------------------------------

interface ParameterType {
  name: string[];
  validate(arg: Arg, args: Arg[], index: number, state?: StateInfo): TypeError | TypeWarning | null;
}

class TypeError {
  constructor(public message: string) {}
}

class TypeWarning {
  constructor(public message: string) {}
}

/**
 * "Always" arguments — variables and expressions pass any type check because
 * we cannot determine their runtime value statically.
 */
function isAlwaysArg(arg: Arg): boolean {
  return arg.type === ArgType.Variable || arg.type === ArgType.Expression;
}

// Type definitions
const parameterTypes: ParameterType[] = [
  {
    name: ['bool', 'boolean'],
    validate(arg) {
      return arg.type === ArgType.Boolean ? null : new TypeError('Argument is not a boolean');
    },
  },
  {
    name: ['null'],
    validate(arg) {
      return arg.type === ArgType.Null ? null : new TypeError("Argument is not 'null'");
    },
  },
  {
    name: ['undefined'],
    validate(arg) {
      return arg.type === ArgType.Undefined ? null : new TypeError("Argument is not 'undefined'");
    },
  },
  {
    name: ['number'],
    validate(arg) {
      return arg.type === ArgType.Number ? null : new TypeError('Argument is not a number');
    },
  },
  {
    name: ['NaN'],
    validate(arg) {
      return arg.type === ArgType.NaN ? null : new TypeError("Argument is not 'NaN'");
    },
  },
  {
    name: ['link'],
    validate(arg) {
      return arg.type === ArgType.Link ? null : new TypeError('Argument is not a link');
    },
  },
  {
    name: ['image'],
    validate(arg) {
      return arg.type === ArgType.Image ? null : new TypeError('Argument is not an image');
    },
  },
  {
    name: ['bareword'],
    validate(arg) {
      return arg.type === ArgType.Bareword ? null : new TypeError('Argument is not a bareword');
    },
  },
  {
    name: ['string'],
    validate(arg) {
      return arg.type === ArgType.String ? null : new TypeError('Argument is not a quoted string');
    },
  },
  {
    name: ['text'],
    validate(arg) {
      const t = arg.type;
      if (
        t === ArgType.Bareword ||
        t === ArgType.String ||
        t === ArgType.Boolean ||
        t === ArgType.Null ||
        t === ArgType.NaN ||
        t === ArgType.Number
      ) {
        return null;
      }
      return new TypeError('Argument is not text');
    },
  },
  {
    name: ['var'],
    validate(arg) {
      return arg.type === ArgType.Variable ? null : new TypeError('Argument is not a variable');
    },
  },
  {
    // The story variable a form control binds to: `$name` or `"$name"`.
    // Spindle strips the quotes and the `$` sigil from the first argument
    // and reads the rest as a dot path into the story variables.
    name: ['receiver'],
    validate(arg) {
      if (arg.type !== ArgType.String && arg.type !== ArgType.Bareword) {
        return new TypeError('Argument is not a variable receiver');
      }
      try {
        const binding = parseBoundVariable(arg.text);
        if (!binding) return new TypeError('Argument is not a variable receiver');
        // The configured schema constrains the root's spelling; the runtime
        // reader owns member names, including Unicode identifier escapes.
        const root = `${binding.explicitSigil ? '$' : ''}${binding.name}`;
        if (!/^(?:\$\w|[A-Za-z_])[\w$]*$/.test(root)) {
          return new TypeError(`Argument is not a valid variable receiver: '${root}'`);
        }
      } catch (error) {
        return new TypeError(`Invalid story variable receiver: ${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    },
  },
  {
    name: ['passage'],
    validate(arg, _args, _index, state) {
      // Extract passage name from the argument
      let passageName: string | undefined;
      if (arg.type === ArgType.String) {
        const target = passageTarget(arg.text);
        if (target.kind === 'name') passageName = target.name;
      } else if (arg.type === ArgType.Bareword) {
        passageName = arg.text;
      } else if (arg.type === ArgType.Number) {
        passageName = arg.text;
      } else if (arg.type === ArgType.NaN) {
        passageName = 'NaN';
      }

      if (passageName !== undefined) {
        if (state && state.passages.length > 0) {
          if (!state.passages.includes(passageName)) {
            return new TypeWarning(`Nonexistent passage: "${passageName}"`);
          }
        }
        return null;
      }

      return new TypeError('Argument is not an acceptable passage');
    },
  },
];

function findParameterType(name: string): ParameterType | null {
  for (const pt of parameterTypes) {
    if (pt.name.includes(name)) return pt;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Format tree types
// ---------------------------------------------------------------------------

enum FormatKind {
  Type,
  Literal,
  Group,
  AndNext,
  MaybeNext,
  Or,
  Repeat,
}

type Format =
  | FormatType
  | FormatLiteral
  | FormatAndNext
  | FormatMaybeNext
  | FormatOr
  | FormatRepeat;

interface FormatType {
  kind: FormatKind.Type;
  type: ParameterType;
}
interface FormatLiteral {
  kind: FormatKind.Literal;
  value: string;
}
interface FormatAndNext {
  kind: FormatKind.AndNext;
  left: Format;
  right: Format;
}
interface FormatMaybeNext {
  kind: FormatKind.MaybeNext;
  left?: Format;
  right: Format;
}
interface FormatOr {
  kind: FormatKind.Or;
  left: Format;
  right: Format;
}
interface FormatRepeat {
  kind: FormatKind.Repeat;
  right: Format;
}

// Lex tokens (superset of Format for groups)
type FormatLex =
  | FormatType
  | FormatLiteral
  | { kind: FormatKind.Group; open: boolean }
  | { kind: FormatKind.AndNext }
  | { kind: FormatKind.MaybeNext }
  | { kind: FormatKind.Or }
  | { kind: FormatKind.Repeat };

// ---------------------------------------------------------------------------
// Format string lexer
// ---------------------------------------------------------------------------

const LEX_LIMIT = 1000;
const wsRe = /\s/;
const identStartRe = /[a-zA-Z]/;
const identStopRe = /[|&+\-\s)(]/;
const quoteRe = /['"]/;
const digitRe = /[0-9]/;

function lexFormat(formatString: string): FormatLex[] {
  let pos = 0;
  const lexed: FormatLex[] = [];
  let iter = 0;

  for (;;) {
    if (++iter > LEX_LIMIT) throw new Error('Format lex iteration limit exceeded');
    if (pos >= formatString.length) break;

    const ch = formatString[pos];

    if (wsRe.test(ch)) {
      pos++;
    } else if (ch === '&') {
      pos++;
      const next = formatString[pos];
      if (next === '+') {
        pos++;
        lexed.push({ kind: FormatKind.AndNext });
      } else {
        throw new Error(`Lex: Expected '+' after '&', found '${next ?? 'EOF'}'`);
      }
    } else if (ch === '|') {
      pos++;
      const next = formatString[pos];
      if (next === '+') {
        pos++;
        lexed.push({ kind: FormatKind.MaybeNext });
      } else if (next === undefined) {
        throw new Error("Lex: Expected content after '|'");
      } else if (wsRe.test(next)) {
        pos++;
        lexed.push({ kind: FormatKind.Or });
      } else if (identStartRe.test(next) || quoteRe.test(next)) {
        lexed.push({ kind: FormatKind.Or });
      } else {
        throw new Error(`Lex: Invalid character after '|': '${next}'`);
      }
    } else if (quoteRe.test(ch)) {
      const quoted = readQuoted(formatString, pos);
      if (!quoted) throw new Error('Lex: Unterminated string literal');
      pos = quoted.end;
      lexed.push({ kind: FormatKind.Literal, value: quoted.value });
    } else if (ch === '(' || ch === ')') {
      pos++;
      lexed.push({ kind: FormatKind.Group, open: ch === '(' });
    } else if (identStartRe.test(ch)) {
      const start = pos;
      pos++;
      while (pos < formatString.length) {
        if (++iter > LEX_LIMIT) throw new Error('Format lex identifier iteration limit exceeded');
        const c = formatString[pos];
        if (identStopRe.test(c) || c === undefined) break;
        if (identStartRe.test(c)) {
          pos++;
        } else if (digitRe.test(c)) {
          throw new Error(`Lex: Digit '${c}' not allowed in parameter type name`);
        } else {
          throw new Error(`Lex: Invalid character '${c}' in parameter type name`);
        }
      }
      const ident = formatString.slice(start, pos);
      const pt = findParameterType(ident);
      if (pt === null) throw new Error(`Lex: Unknown parameter type '${ident}'`);
      lexed.push({ kind: FormatKind.Type, type: pt });
    } else if (ch === '.' && formatString[pos + 1] === '.' && formatString[pos + 2] === '.') {
      pos += 3;
      lexed.push({ kind: FormatKind.Repeat });
    } else {
      throw new Error(`Lex: Unexpected character '${ch}'`);
    }
  }

  return lexed;
}

// ---------------------------------------------------------------------------
// Format string parser (Pratt parser)
// ---------------------------------------------------------------------------

const PARSE_LIMIT = 2000;

function parseFormat(formatString: string): Format | null {
  const tokens = lexFormat(formatString);
  if (tokens.length === 0) return null;

  let index = 0;
  let iter = 0;

  function infixBp(kind: FormatKind): [number, number] | null {
    switch (kind) {
      case FormatKind.Or: return [9, 10];
      case FormatKind.AndNext: return [4, 5];
      case FormatKind.MaybeNext: return [2, 3];
      default: return null;
    }
  }

  function prefixBp(kind: FormatKind): number {
    switch (kind) {
      case FormatKind.MaybeNext: return 3;
      case FormatKind.Repeat: return 8;
      default: throw new Error(`Parse: Unexpected prefix operator kind ${kind}`);
    }
  }

  function isPrefixOp(t: FormatLex): boolean {
    return t.kind === FormatKind.MaybeNext || t.kind === FormatKind.Repeat;
  }

  function isValue(t: FormatLex): t is FormatType | FormatLiteral {
    return t.kind === FormatKind.Type || t.kind === FormatKind.Literal;
  }

  function exprBp(minBp: number): Format {
    if (++iter > PARSE_LIMIT) throw new Error('Format parse iteration limit exceeded');
    const cur = tokens[index];
    if (!cur) throw new Error('Parse: Unexpected end of format string');
    index++;

    let lhs: Format;

    if (isPrefixOp(cur)) {
      const rBp = prefixBp(cur.kind);
      const rhs = exprBp(rBp);
      lhs = { kind: cur.kind, right: rhs } as Format;
    } else if (cur.kind === FormatKind.Group) {
      const g = cur as { kind: FormatKind.Group; open: boolean };
      if (!g.open) throw new Error('Parse: Unexpected closing parenthesis');
      lhs = exprBp(0);
      const closing = tokens[index];
      if (!closing || closing.kind !== FormatKind.Group || (closing as { open: boolean }).open) {
        throw new Error('Parse: Expected closing parenthesis');
      }
      index++;
    } else if (isValue(cur)) {
      lhs = cur;
    } else {
      throw new Error('Parse: Expected value or prefix operator');
    }

    for (;;) {
      if (++iter > PARSE_LIMIT) throw new Error('Format parse operator iteration limit exceeded');
      const op = tokens[index];
      if (!op) break;
      const bp = infixBp(op.kind);
      if (bp === null) break;
      const [lBp, rBp] = bp;
      if (lBp < minBp) break;
      index++;
      const rhs = exprBp(rBp);
      lhs = { kind: op.kind, left: lhs, right: rhs } as Format;
    }

    return lhs;
  }

  return exprBp(0);
}

// ---------------------------------------------------------------------------
// Positional description (for editor signature help)
// ---------------------------------------------------------------------------

/** One argument position of a schema. */
export interface ParameterSlot {
  /** Type name, or the quoted literal for literal positions. */
  label: string;
  /** The position may be omitted (`|+`). */
  optional: boolean;
  /** The position may repeat (`...`). */
  repeat: boolean;
  /**
   * Whether a typed argument can occupy this position, judged by the same
   * format-tree crawl the validator uses (variables and expressions always
   * pass; a type warning is not a rejection).
   */
  accepts(arg: Arg): boolean;
}

const DESCRIBE_ALTERNATIVE_LIMIT = 16;

/**
 * Expand a format into its alternative positional sequences. `|` yields one
 * sequence per branch, `|+` yields the sequence with its right side optional.
 */
function slotAccepts(leaf: Format): (arg: Arg) => boolean {
  return (arg) => crawlValidate(leaf, [arg], 0).status === CrawlStatus.Success;
}

function describeFormat(format: Format): ParameterSlot[][] {
  const cap = (list: ParameterSlot[][]) => list.slice(0, DESCRIBE_ALTERNATIVE_LIMIT);
  const join = (lefts: ParameterSlot[][], rights: ParameterSlot[][]) =>
    cap(lefts.flatMap((l) => rights.map((r) => [...l, ...r])));
  switch (format.kind) {
    case FormatKind.Type:
      return [[{ label: format.type.name[0], optional: false, repeat: false, accepts: slotAccepts(format) }]];
    case FormatKind.Literal:
      return [[{ label: `'${format.value}'`, optional: false, repeat: false, accepts: slotAccepts(format) }]];
    case FormatKind.AndNext:
      return join(describeFormat(format.left), describeFormat(format.right));
    case FormatKind.MaybeNext: {
      const rights = describeFormat(format.right).map((seq) =>
        seq.map((slot) => ({ ...slot, optional: true })),
      );
      return join(format.left ? describeFormat(format.left) : [[]], rights);
    }
    case FormatKind.Or:
      return cap([...describeFormat(format.left), ...describeFormat(format.right)]);
    case FormatKind.Repeat:
      return describeFormat(format.right).map((seq) =>
        seq.map((slot) => ({ ...slot, optional: true, repeat: true })),
      );
  }
}

/** A conservative positional summary; unsafe means passage roles cannot be fixed. */
interface PassageSlots {
  slots: boolean[];
  variable: boolean;
  unsafe: boolean;
  /** First position a repeated non-passage tail can occupy. */
  restFrom?: number;
}

function passageSlots(format: Format): PassageSlots {
  const single = (passage: boolean): PassageSlots => ({ slots: [passage], variable: false, unsafe: false });
  switch (format.kind) {
    case FormatKind.Type: return single(format.type.name.includes('passage'));
    case FormatKind.Literal: return single(false);
    case FormatKind.Repeat: {
      const child = passageSlots(format.right);
      return { slots: [], variable: true, unsafe: child.unsafe || child.slots.includes(true), restFrom: 0 };
    }
    case FormatKind.Or:
      return mergePassageSlots(passageSlots(format.left), passageSlots(format.right));
    case FormatKind.AndNext:
    case FormatKind.MaybeNext: {
      const left = format.left ? passageSlots(format.left) : { slots: [], variable: false, unsafe: false };
      const right = passageSlots(format.right);
      return {
        slots: [...left.slots, ...right.slots],
        variable: left.variable || right.variable || format.kind === FormatKind.MaybeNext,
        restFrom: left.restFrom ?? (right.restFrom === undefined ? undefined : left.slots.length + right.restFrom),
        // A variable-width prefix can move every position that follows it.
        // Refuse rather than attributing an ordinary string to a passage.
        unsafe: left.unsafe || right.unsafe || (left.variable && right.slots.length > 0 &&
          (left.slots.includes(true) || right.slots.includes(true))),
      };
    }
  }
}

function mergePassageSlots(left: PassageSlots, right: PassageSlots): PassageSlots {
  const repeatedConflict = (repeated: PassageSlots, other: PassageSlots) => repeated.restFrom !== undefined
    && other.slots.some((passage, i) => passage && i >= repeated.restFrom!);
  return {
    slots: Array.from({ length: Math.max(left.slots.length, right.slots.length) }, (_, i) =>
      left.slots[i] === true || right.slots[i] === true),
    variable: left.variable || right.variable || left.slots.length !== right.slots.length,
    restFrom: left.restFrom === undefined ? right.restFrom : right.restFrom === undefined
      ? left.restFrom : Math.min(left.restFrom, right.restFrom),
    unsafe: left.unsafe || right.unsafe || left.slots.some((passage, i) =>
      right.slots[i] !== undefined && passage !== right.slots[i])
      || repeatedConflict(left, right) || repeatedConflict(right, left),
  };
}

// ---------------------------------------------------------------------------
// Validator (tree-crawl)
// ---------------------------------------------------------------------------

enum CrawlStatus {
  NotFound,
  Failure,
  Success,
}

interface CrawlResult {
  status: CrawlStatus;
  rank: number;
  argIndex: number;
  errors: ArgumentError[];
  warnings: ArgumentWarning[];
}

function makeError(status: CrawlStatus, message: string, argIndex: number, rank = 0): CrawlResult {
  return {
    status,
    rank,
    argIndex,
    errors: [{ message, argIndex }],
    warnings: [],
  };
}

function makeSuccess(argIndex: number, rank: number, warnings: ArgumentWarning[] = []): CrawlResult {
  return { status: CrawlStatus.Success, rank, argIndex, errors: [], warnings };
}

function isFail(s: CrawlStatus): boolean {
  return s === CrawlStatus.Failure || s === CrawlStatus.NotFound;
}

const VALIDATE_LIMIT = 2000;
const CORRECT_TYPE_RANK = 1;
const CORRECT_RANK = 2;

function crawlValidate(
  format: Format,
  args: Arg[],
  startIndex: number,
  state?: StateInfo,
): CrawlResult {
  const memo = new Map<Format, Map<number, CrawlResult[]>>();

  function append(left: CrawlResult, right: CrawlResult): CrawlResult {
    return { ...right, rank: left.rank + right.rank, warnings: left.warnings.concat(right.warnings) };
  }

  function follow(left: CrawlResult[], right: Format): CrawlResult[] {
    return left.flatMap(matched => isFail(matched.status)
      ? [matched]
      : crawl(right, matched.argIndex).map(result => append(matched, result)));
  }

  // Retain every reachable argument position, once. Two paths to the same
  // position have the same possible continuations; keep the first one's
  // warnings and branch preference, without exponentially revisiting it.
  function crawl(fmt: Format, argIdx: number): CrawlResult[] {
    let positions = memo.get(fmt);
    if (!positions) memo.set(fmt, positions = new Map());
    const cached = positions.get(argIdx);
    if (cached) return cached;
    // Bound positions per node: alternatives must not consume the allowance
    // of an otherwise valid long repetition just by visiting other nodes.
    if (positions.size >= VALIDATE_LIMIT) {
      throw new Error(`Validation iteration limit exceeded at argument ${argIdx}`);
    }
    const unique = new Map<number | 'failure', CrawlResult>();
    for (const result of match(fmt, argIdx)) {
      const key = isFail(result.status) ? 'failure' : result.argIndex;
      const previous = unique.get(key);
      if (!previous || (key === 'failure' && result.rank > previous.rank)) unique.set(key, result);
    }
    const results = [...unique.values()];
    positions.set(argIdx, results);
    return results;
  }

  function match(fmt: Format, argIdx: number): CrawlResult[] {
    switch (fmt.kind) {
      case FormatKind.MaybeNext: {
        const left = fmt.left ? crawl(fmt.left, argIdx) : [makeSuccess(argIdx, 0)];
        return [...follow(left, fmt.right), ...left];
      }

      case FormatKind.AndNext: {
        return follow(crawl(fmt.left, argIdx), fmt.right);
      }

      case FormatKind.Or: {
        return [...crawl(fmt.left, argIdx), ...crawl(fmt.right, argIdx)];
      }

      case FormatKind.Repeat: {
        const matches: CrawlResult[] = [];
        const pending = [makeSuccess(argIdx, 0)];
        const reached = new Set<number>();
        while (pending.length > 0) {
          const matched = pending.pop()!;
          // Mark on visit, so earlier alternatives and their repetitions
          // keep priority over a later alternative reaching the same end.
          if (reached.has(matched.argIndex)) continue;
          reached.add(matched.argIndex);
          matches.push(matched);
          const items = crawl(fmt.right, matched.argIndex);
          for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            // This also stops repetitions of an empty optional group.
            if (!isFail(item.status) && !reached.has(item.argIndex)) pending.push(append(matched, item));
          }
        }
        return matches.sort((left, right) => right.argIndex - left.argIndex);
      }

      case FormatKind.Literal: {
        const arg = args[argIdx];
        if (arg === undefined) {
          return [makeError(CrawlStatus.NotFound, `Expected literal '${fmt.value}' but no argument found`, argIdx)];
        }
        if (isAlwaysArg(arg)) {
          return [makeSuccess(argIdx + 1, CORRECT_RANK)];
        }

        // Check literal match
        const argText = arg.type === ArgType.String ? readQuoted(arg.text, 0)?.value : arg.text;
        if (argText === fmt.value) {
          return [makeSuccess(argIdx + 1, CORRECT_RANK)];
        }
        // Special keyword matches
        if (
          (fmt.value === 'null' && arg.type === ArgType.Null) ||
          (fmt.value === 'undefined' && arg.type === ArgType.Undefined) ||
          (fmt.value === 'true' && arg.type === ArgType.Boolean && arg.text === 'true') ||
          (fmt.value === 'false' && arg.type === ArgType.Boolean && arg.text === 'false') ||
          (fmt.value === 'NaN' && arg.type === ArgType.NaN)
        ) {
          return [makeSuccess(argIdx + 1, CORRECT_RANK)];
        }

        return [makeError(CrawlStatus.Failure, `Expected literal '${fmt.value}'`, argIdx, CORRECT_TYPE_RANK)];
      }

      case FormatKind.Type: {
        const arg = args[argIdx];
        const typeDef = fmt.type;

        if (arg === undefined) {
          return [makeError(
            CrawlStatus.NotFound,
            `Expected type '${typeDef.name[0]}' but no argument found`,
            argIdx,
          )];
        }

        if (isAlwaysArg(arg)) {
          return [makeSuccess(argIdx + 1, CORRECT_RANK)];
        }

        const result = typeDef.validate(arg, args, argIdx, state);
        if (result instanceof TypeError) {
          return [{
            status: CrawlStatus.Failure,
            rank: 0,
            argIndex: argIdx,
            errors: [{ message: result.message, argIndex: argIdx }],
            warnings: [],
          }];
        }
        if (result instanceof TypeWarning) {
          return [makeSuccess(argIdx + 1, CORRECT_RANK, [
            { message: result.message, argIndex: argIdx },
          ])];
        }

        return [makeSuccess(argIdx + 1, CORRECT_RANK)];
      }
    }
  }

  const results = crawl(format, startIndex);
  return results.find(result => !isFail(result.status) && result.argIndex === args.length)
    ?? results.reduce((best, result) => result.rank > best.rank ? result : best);
}

// ---------------------------------------------------------------------------
// Parameters class (public API)
// ---------------------------------------------------------------------------

interface ParsedVariant {
  formatString: string;
  format: Format | null;
}

export class Parameters {
  private variants: ParsedVariant[];

  constructor(variants: string[]) {
    this.variants = variants.map((s) => ({
      formatString: s,
      format: parseFormat(s),
    }));
  }

  /**
   * Describe every argument position of every schema variant. Alternatives
   * (`|`) and optional positions (`|+`) become separate sequences; an empty
   * schema is the empty sequence. Variants whose format cannot be parsed
   * contribute nothing.
   */
  describe(): ParameterSlot[][] {
    const sequences: ParameterSlot[][] = [];
    for (const variant of this.variants) {
      if (variant.format === null) sequences.push([]);
      else sequences.push(...describeFormat(variant.format));
    }
    return sequences;
  }

  /**
   * Passage positions that have the same role in every schema alternative.
   * Unlike describe(), this walks the whole tree without truncating branches.
   * Repeated or conflicting passage roles return null so callers can refuse
   * an unsafe rename; actual argument spans and values remain Spindle's job.
   */
  passagePositions(): number[] | null {
    const summary = this.variants.map(variant => variant.format
      ? passageSlots(variant.format)
      : { slots: [], variable: false, unsafe: false })
      .reduce(mergePassageSlots, { slots: [], variable: false, unsafe: false });
    return summary.unsafe ? null : summary.slots.flatMap((passage, i) => passage ? [i] : []);
  }

  /**
   * Validate an array of Arg tokens against these parameter variants.
   * Selects the best-matching variant by rank.
   */
  validate(args: Arg[], stateInfo?: StateInfo): ValidationResult {
    // Handle case where no variants exist
    if (this.variants.length === 0) {
      if (args.length === 0) {
        return { variantIndex: null, errors: [], warnings: [] };
      }
      return {
        variantIndex: null,
        errors: [{ message: 'Expected no arguments', argIndex: 0 }],
        warnings: [],
      };
    }

    let bestIndex: number | null = null;
    let bestRank = -Infinity;
    let bestErrors: ArgumentError[] = [];
    let bestWarnings: ArgumentWarning[] = [];
    let bestIsClean = false; // tracks whether the best has zero errors

    for (let i = 0; i < this.variants.length; i++) {
      const variant = this.variants[i];

      if (variant.format === null) {
        // Empty variant: accepts zero arguments
        if (args.length === 0) {
          // Perfect match — no errors
          if (!bestIsClean || 0 > bestRank) {
            bestIndex = i;
            bestRank = 0;
            bestErrors = [];
            bestWarnings = [];
            bestIsClean = true;
          }
        } else {
          // Args provided but variant expects none
          if (!bestIsClean && bestIndex === null) {
            bestIndex = i;
            bestRank = -1;
            bestErrors = [{ message: 'Expected no arguments', argIndex: 0 }];
            bestWarnings = [];
          }
        }
        continue;
      }

      const result = crawlValidate(variant.format, args, 0, stateInfo);

      // Check for unconsumed arguments
      let errors = result.errors;
      if (result.errors.length === 0 && result.argIndex < args.length) {
        errors = [
          {
            message: `Too many arguments: expected ${result.argIndex}, got ${args.length}`,
            argIndex: result.argIndex,
          },
        ];
      }

      const rank = result.rank;
      const isClean = errors.length === 0;

      if (isClean && (!bestIsClean || rank > bestRank)) {
        // Clean result beats any errored result, or a better clean result
        bestIndex = i;
        bestRank = rank;
        bestErrors = [];
        bestWarnings = result.warnings;
        bestIsClean = true;
      } else if (!isClean && !bestIsClean && rank > bestRank) {
        // Both errored — pick the higher-ranked error
        bestIndex = i;
        bestRank = rank;
        bestErrors = errors;
        bestWarnings = result.warnings;
      } else if (bestIndex === null) {
        // First variant tried — store as default
        bestIndex = i;
        bestRank = rank;
        bestErrors = errors;
        bestWarnings = result.warnings;
        bestIsClean = isClean;
      }
    }

    return {
      variantIndex: bestIndex,
      errors: bestErrors,
      warnings: bestWarnings,
    };
  }

  /**
   * Whether all variants are empty (accept no arguments).
   */
  isEmpty(): boolean {
    if (this.variants.length === 0) return true;
    return !this.variants.some((v) => v.format !== null);
  }
}
