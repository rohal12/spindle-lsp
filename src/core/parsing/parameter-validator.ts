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
    name: ['passage'],
    validate(arg, _args, _index, state) {
      // Extract passage name from the argument
      let passageName: string | undefined;
      if (arg.type === ArgType.String) {
        // Strip quotes
        passageName = arg.text.slice(1, -1);
      } else if (arg.type === ArgType.Bareword) {
        passageName = arg.text;
      } else if (arg.type === ArgType.Number) {
        passageName = arg.text;
      } else if (arg.type === ArgType.NaN) {
        passageName = 'NaN';
      }

      if (passageName !== undefined) {
        passageName = passageName.replace(/\\/g, '');
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
      const openQuote = ch;
      const start = pos;
      pos++;
      while (pos < formatString.length && formatString[pos] !== openQuote) {
        if (++iter > LEX_LIMIT) throw new Error('Format lex string iteration limit exceeded');
        pos++;
      }
      if (pos >= formatString.length) throw new Error('Lex: Unterminated string literal');
      const value = formatString.slice(start + 1, pos);
      pos++; // skip closing quote
      lexed.push({ kind: FormatKind.Literal, value });
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
// Format tree utilities
// ---------------------------------------------------------------------------

function formatArgCountRange(format: Format): { min: number; max: number } {
  switch (format.kind) {
    case FormatKind.Type:
    case FormatKind.Literal:
      return { min: 1, max: 1 };
    case FormatKind.AndNext: {
      const l = formatArgCountRange(format.left);
      const r = formatArgCountRange(format.right);
      return { min: l.min + r.min, max: l.max + r.max };
    }
    case FormatKind.MaybeNext: {
      const l = format.left ? formatArgCountRange(format.left) : { min: 0, max: 0 };
      const r = formatArgCountRange(format.right);
      return { min: l.min, max: l.max + r.max };
    }
    case FormatKind.Or: {
      const l = formatArgCountRange(format.left);
      const r = formatArgCountRange(format.right);
      return { min: Math.min(l.min, r.min), max: Math.max(l.max, r.max) };
    }
    case FormatKind.Repeat:
      return { min: 0, max: Infinity };
  }
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
  let iter = 0;

  function crawl(fmt: Format, argIdx: number): CrawlResult {
    if (++iter > VALIDATE_LIMIT) {
      throw new Error(`Validation iteration limit exceeded at argument ${argIdx}`);
    }

    switch (fmt.kind) {
      case FormatKind.MaybeNext: {
        let rank = 0;
        let warnings: ArgumentWarning[] = [];
        let idx = argIdx;

        if (fmt.left) {
          const left = crawl(fmt.left, idx);
          if (isFail(left.status)) return left;
          rank += left.rank;
          idx = left.argIndex;
          warnings = left.warnings;
        }

        const right = crawl(fmt.right, idx);
        if (right.status === CrawlStatus.NotFound) {
          return makeSuccess(idx, rank, warnings);
        }
        if (isFail(right.status)) {
          right.status = CrawlStatus.Failure;
          return right;
        }

        return makeSuccess(right.argIndex, rank + right.rank, warnings.concat(right.warnings));
      }

      case FormatKind.AndNext: {
        const left = crawl(fmt.left, argIdx);
        if (isFail(left.status)) return left;

        const right = crawl(fmt.right, left.argIndex);
        if (isFail(right.status)) return right;

        return makeSuccess(
          right.argIndex,
          left.rank + right.rank,
          left.warnings.concat(right.warnings),
        );
      }

      case FormatKind.Or: {
        const left = crawl(fmt.left, argIdx);
        if (!isFail(left.status)) return left;

        const right = crawl(fmt.right, argIdx);
        if (!isFail(right.status)) return right;

        // Both failed — return left's error
        return left;
      }

      case FormatKind.Repeat: {
        let rank = 0;
        let warnings: ArgumentWarning[] = [];
        let idx = argIdx;

        for (;;) {
          const r = crawl(fmt.right, idx);
          if (isFail(r.status)) break;
          idx = r.argIndex;
          rank += r.rank;
          warnings = warnings.concat(r.warnings);
        }

        return makeSuccess(idx, rank, warnings);
      }

      case FormatKind.Literal: {
        const arg = args[argIdx];
        if (arg === undefined) {
          return makeError(CrawlStatus.NotFound, `Expected literal '${fmt.value}' but no argument found`, argIdx);
        }
        if (isAlwaysArg(arg)) {
          return makeSuccess(argIdx + 1, CORRECT_RANK);
        }

        // Check literal match
        const argText = arg.type === ArgType.String ? arg.text.slice(1, -1) : arg.text;
        if (argText === fmt.value) {
          return makeSuccess(argIdx + 1, CORRECT_RANK);
        }
        // Special keyword matches
        if (
          (fmt.value === 'null' && arg.type === ArgType.Null) ||
          (fmt.value === 'undefined' && arg.type === ArgType.Undefined) ||
          (fmt.value === 'true' && arg.type === ArgType.Boolean && arg.text === 'true') ||
          (fmt.value === 'false' && arg.type === ArgType.Boolean && arg.text === 'false') ||
          (fmt.value === 'NaN' && arg.type === ArgType.NaN)
        ) {
          return makeSuccess(argIdx + 1, CORRECT_RANK);
        }

        return makeError(CrawlStatus.Failure, `Expected literal '${fmt.value}'`, argIdx, CORRECT_TYPE_RANK);
      }

      case FormatKind.Type: {
        const arg = args[argIdx];
        const typeDef = fmt.type;

        if (arg === undefined) {
          return makeError(
            CrawlStatus.NotFound,
            `Expected type '${typeDef.name[0]}' but no argument found`,
            argIdx,
          );
        }

        if (isAlwaysArg(arg)) {
          return makeSuccess(argIdx + 1, CORRECT_RANK);
        }

        const result = typeDef.validate(arg, args, argIdx, state);
        if (result instanceof TypeError) {
          return {
            status: CrawlStatus.Failure,
            rank: 0,
            argIndex: argIdx,
            errors: [{ message: result.message, argIndex: argIdx }],
            warnings: [],
          };
        }
        if (result instanceof TypeWarning) {
          return makeSuccess(argIdx + 1, CORRECT_RANK, [
            { message: result.message, argIndex: argIdx },
          ]);
        }

        return makeSuccess(argIdx + 1, CORRECT_RANK);
      }
    }
  }

  return crawl(format, startIndex);
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
   * Compute the min/max argument count across all variants.
   */
  argCountRange(): { min: number; max: number } {
    let min = Infinity;
    let max = 0;

    for (const variant of this.variants) {
      if (variant.format === null) {
        min = 0;
      } else {
        const range = formatArgCountRange(variant.format);
        min = Math.min(min, range.min);
        max = Math.max(max, range.max);
      }
    }

    if (min === Infinity) min = 0;
    return { min, max };
  }

  /**
   * Whether all variants are empty (accept no arguments).
   */
  isEmpty(): boolean {
    if (this.variants.length === 0) return true;
    return !this.variants.some((v) => v.format !== null);
  }
}
