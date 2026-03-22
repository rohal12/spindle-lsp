/**
 * Argument lexer for Spindle macro arguments.
 *
 * Tokenizes the raw argument string from a macro invocation into typed Arg tokens.
 * Ported from twee3-language-tools/src/spindle-0/arguments.ts with simplifications:
 *   - No dependency on vscode.Range (uses plain start/end offsets)
 *   - Unified Boolean type (instead of separate True/False)
 *   - Dot-path extraction for variables ($player.health -> path=["player","health"])
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export enum ArgType {
  String,
  Number,
  Boolean,
  Null,
  Variable,
  Link,
  Image,
  Expression,
  Bareword,
  NaN,
  Undefined,
}

export interface Arg {
  type: ArgType;
  text: string;
  start: number;
  end: number;
  /** Variable sigil: $, _, or @ */
  sigil?: '$' | '_' | '@';
  /** Dot-access path segments, e.g. $player.health -> ["player", "health"] */
  path?: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Lex a raw argument string into an array of typed Arg tokens.
 */
export function lexArguments(source: string): Arg[] {
  const lexer = new Lexer(source, lexSpace);
  const rawItems = lexer.run();

  const args: Arg[] = [];
  for (const item of rawItems) {
    if (item.type === RawItem.Error) {
      // Stop on first error — mirrors the reference implementation
      break;
    }
    args.push(classifyToken(item));
  }
  return args;
}

/**
 * Count the number of arguments in a raw argument string.
 */
export function countArguments(source: string): number {
  return lexArguments(source).length;
}

// ---------------------------------------------------------------------------
// Token classification
// ---------------------------------------------------------------------------

const varTestRegexp = /^[$_@][$A-Z_a-z][$0-9A-Z_.a-z]*/;

function classifyToken(item: LexerItem<RawItem>): Arg {
  const text = item.text;
  const base = { text, start: item.start, end: item.position };

  switch (item.type) {
    case RawItem.String:
      return { ...base, type: ArgType.String };

    case RawItem.Expression:
      return { ...base, type: ArgType.Expression };

    case RawItem.SquareBracket: {
      // Determine if it's a link or image based on the opening characters.
      // Images start with [img[, [<img[, [>img[  (case-insensitive)
      // Links start with [[
      const inner = text.slice(1); // skip first [
      if (/^[<>]?[Ii][Mm][Gg]\[/.test(inner)) {
        return { ...base, type: ArgType.Image };
      }
      return { ...base, type: ArgType.Link };
    }

    case RawItem.Bareword: {
      // Variable?
      if (varTestRegexp.test(text)) {
        const sigil = text[0] as '$' | '_' | '@';
        const pathParts = text.slice(1).split('.');
        return {
          ...base,
          type: ArgType.Variable,
          sigil,
          path: pathParts,
        };
      }

      // Keywords
      if (text === 'null') return { ...base, type: ArgType.Null };
      if (text === 'undefined') return { ...base, type: ArgType.Undefined };
      if (text === 'true') return { ...base, type: ArgType.Boolean };
      if (text === 'false') return { ...base, type: ArgType.Boolean };
      if (text === 'NaN') return { ...base, type: ArgType.NaN };

      // Number? (including negative numbers like -5, floats like 3.14)
      const asNum = Number(text);
      if (!Number.isNaN(asNum)) {
        return { ...base, type: ArgType.Number };
      }

      // Fallback: bareword
      return { ...base, type: ArgType.Bareword };
    }

    default:
      return { ...base, type: ArgType.Bareword };
  }
}

// ---------------------------------------------------------------------------
// Generic lexer engine (ported from reference)
// ---------------------------------------------------------------------------

type LexerState<T> = (lexer: Lexer<T>) => LexerState<T> | null;

interface LexerItem<T> {
  type: T;
  text: string;
  start: number;
  position: number;
  message?: string;
}

const EOF = -1 as const;
type EOFT = -1;

class Lexer<T> {
  readonly source: string;
  state: LexerState<T> | null;
  start = 0;
  pos = 0;
  depth = 0;
  items: LexerItem<T>[] = [];

  constructor(source: string, initial: LexerState<T>) {
    this.source = source;
    this.state = initial;
  }

  run(): LexerItem<T>[] {
    while (this.state !== null) {
      this.state = this.state(this);
    }
    return this.items;
  }

  next(): EOFT | string {
    const ch = this.peek();
    this.pos++;
    return ch;
  }

  peek(): EOFT | string {
    if (this.pos >= this.source.length) return EOF;
    return this.source[this.pos];
  }

  backup(num = 1) {
    this.pos -= num;
  }

  forward(num = 1) {
    this.pos += num;
  }

  ignore() {
    this.start = this.pos;
  }

  accept(valid: string): boolean {
    const ch = this.next();
    if (ch === EOF) return false;
    if (valid.includes(ch as string)) return true;
    this.backup();
    return false;
  }

  acceptRun(valid: string) {
    for (;;) {
      const ch = this.next();
      if (ch === EOF) return;
      if (!valid.includes(ch as string)) {
        break;
      }
    }
    this.backup();
  }

  emit(type: T) {
    this.items.push({
      type,
      text: this.source.slice(this.start, this.pos),
      start: this.start,
      position: this.pos,
    });
    this.start = this.pos;
  }

  error(type: T, message: string): null {
    this.items.push({
      type,
      message,
      text: this.source.slice(this.start, this.pos),
      start: this.start,
      position: this.pos,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Macro-argument lexer states
// ---------------------------------------------------------------------------

enum RawItem {
  Error,
  Bareword,
  Expression,
  String,
  SquareBracket,
}

const notSpaceRegex = /\S/;
const spaceRegex = /\s/;

function slurpQuote(lexer: Lexer<RawItem>, endQuote: string): EOFT | number {
  for (;;) {
    const next = lexer.next();
    if (next === '\\') {
      const ch = lexer.next();
      if (ch !== EOF && ch !== '\n') continue;
    } else if (next === EOF) {
      return EOF;
    } else if (next === '\n' && endQuote !== '`') {
      return EOF;
    } else if (next === endQuote) {
      break;
    }
  }
  return lexer.pos;
}

function lexSpace(lexer: Lexer<RawItem>): LexerState<RawItem> | null {
  const offset = lexer.source.slice(lexer.pos).search(notSpaceRegex);

  if (offset === -1) return null;
  if (offset !== 0) {
    lexer.pos += offset;
    lexer.ignore();
  }

  // Skip commas as argument separators
  if (lexer.peek() === ',') {
    lexer.next();
    lexer.ignore();
    return lexSpace;
  }

  switch (lexer.next()) {
    case '`':
      return lexExpression;
    case '"':
      return lexDoubleQuote;
    case "'":
      return lexSingleQuote;
    case '[':
      return lexSquareBracket;
    default:
      return lexBareword;
  }
}

function lexExpression(lexer: Lexer<RawItem>): LexerState<RawItem> | null {
  if (slurpQuote(lexer, '`') === EOF) {
    return lexer.error(RawItem.Error, 'unterminated backquote expression');
  }
  lexer.emit(RawItem.Expression);
  return lexSpace;
}

function lexDoubleQuote(lexer: Lexer<RawItem>): LexerState<RawItem> | null {
  if (slurpQuote(lexer, '"') === EOF) {
    return lexer.error(RawItem.Error, 'unterminated double quoted string');
  }
  lexer.emit(RawItem.String);
  return lexSpace;
}

function lexSingleQuote(lexer: Lexer<RawItem>): LexerState<RawItem> | null {
  if (slurpQuote(lexer, "'") === EOF) {
    return lexer.error(RawItem.Error, 'unterminated single quoted string');
  }
  lexer.emit(RawItem.String);
  return lexSpace;
}

function lexSquareBracket(lexer: Lexer<RawItem>): LexerState<RawItem> | null {
  const imgMeta = '<>IiMmGg';
  let what: string;

  if (lexer.accept(imgMeta)) {
    what = 'image';
    lexer.acceptRun(imgMeta);
  } else {
    what = 'link';
  }

  if (!lexer.accept('[')) {
    return lexer.error(RawItem.Error, `malformed ${what} markup`);
  }

  lexer.depth = 2;

  for (;;) {
    switch (lexer.next()) {
      case '\\': {
        const ch = lexer.next();
        if (ch !== EOF && ch !== '\n') break;
      }
      /* falls through */
      case EOF:
      case '\n':
        return lexer.error(RawItem.Error, `unterminated ${what} markup`);
      case '[':
        ++lexer.depth;
        break;
      case ']':
        --lexer.depth;
        if (lexer.depth < 0) {
          return lexer.error(RawItem.Error, "unexpected right square bracket ']'");
        }
        if (lexer.depth === 1) {
          if (lexer.next() === ']') {
            --lexer.depth;
            // break out of the for loop
            lexer.emit(RawItem.SquareBracket);
            return lexSpace;
          }
          lexer.backup();
        }
        break;
    }
  }
}

function lexBareword(lexer: Lexer<RawItem>): LexerState<RawItem> | null {
  const offset = lexer.source.slice(lexer.pos).search(spaceRegex);
  if (offset === -1) {
    // Rest of string is bareword; check for comma at end
    let end = lexer.source.length;
    // Trim trailing commas from bareword
    while (end > lexer.pos && lexer.source[end - 1] === ',') {
      end--;
    }
    lexer.pos = end;
    lexer.emit(RawItem.Bareword);
    // If there was a comma, continue lexing
    if (end < lexer.source.length) {
      lexer.pos = end + 1; // skip the comma
      lexer.ignore();
      return lexSpace;
    }
    return null;
  }

  // Check if comma comes before space
  const commaOffset = lexer.source.slice(lexer.pos).indexOf(',');
  if (commaOffset !== -1 && commaOffset < offset) {
    lexer.pos += commaOffset;
    lexer.emit(RawItem.Bareword);
    lexer.pos++; // skip comma
    lexer.ignore();
    return lexSpace;
  }

  lexer.pos += offset;
  lexer.emit(RawItem.Bareword);
  return lexSpace;
}
