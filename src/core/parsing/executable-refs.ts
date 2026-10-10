import {
  SIGIL_SCOPES,
  lexJs,
  pieceOffset,
  tokenizeMarkupTolerant,
  type JsGoal,
  type MacroToken,
  type MarkupErrorCode,
  type Sigil,
  type ToolingMacro,
  type Token,
  type VariableScope,
} from '@rohal12/spindle/tooling';
import type { PassageMarkup } from '../markup/passage-markup.js';

/** A `$var.path` / `%var.path` / `_var` / `@var` reference a passage evaluates. */
export interface VariableReference {
  sigil: Sigil;
  /** The dotted path after the sigil: `player.stats.hp`. */
  path: string;
  /** Offsets in the passage's `content` of the sigil and of the end of the path. */
  start: number;
  end: number;
  /**
   * Whether Spindle's startup validation checks it (`validatePassages`: the
   * `$` references of `{$x}` displays, expressions, macro arguments by their
   * parameters, labels and attribute values, and the bound variable of input
   * macros). The others are only found, for navigation and rename: the
   * variable a macro declares (`{unset $x}`) and the selectors of a link.
   */
  validated: boolean;
}

const SCOPE_SIGILS = Object.fromEntries(
  Object.entries(SIGIL_SCOPES).map(([sigil, scope]) => [scope, sigil]),
) as Record<VariableScope, Sigil>;

type Add = (reference: VariableReference) => void;

function isWordCharacter(ch: string | undefined): boolean {
  return ch !== undefined && /\w/.test(ch);
}

/** The end of the property path (`.b.c`) that continues a variable name ending at `end`. */
function pathEnd(code: string, end: number): number {
  while (code[end] === '.' && isWordCharacter(code[end + 1])) {
    end++;
    while (isWordCharacter(code[end])) end++;
  }
  return end;
}

/**
 * The variable references in `code`, outside its string literals, regex
 * literals and comments (`lexJs`, the lexer the runtime reads code with).
 * `offsetOf` maps an index in `code` to an offset in the passage.
 */
function scanCode(
  code: string,
  goal: JsGoal,
  offsetOf: (index: number) => number,
  validated: boolean,
  add: Add,
  only?: ReadonlySet<Sigil>,
): void {
  lexJs(code, {
    variable(sigil, name, index) {
      if (only && !only.has(sigil)) return;
      const end = pathEnd(code, index + 1 + name.length);
      add({ sigil, path: code.slice(index + 1, end), start: offsetOf(index), end: offsetOf(end - 1) + 1, validated });
    },
  }, goal);
}

const LOCALS: ReadonlySet<Sigil> = new Set<Sigil>(['_', '@']);

/** The `{$name}` interpolations of the `.class#id` selectors of a token. */
function scanSelectors(
  content: string,
  token: { selectorsStart?: number; selectorsEnd?: number },
  validated: boolean,
  add: Add,
): void {
  if (token.selectorsStart === undefined || token.selectorsEnd === undefined) return;
  const base = token.selectorsStart;
  const { tokens } = tokenizeMarkupTolerant(content.slice(base, token.selectorsEnd), { text: true });
  for (const t of tokens) {
    if (t.type !== 'variable') continue;
    add({ sigil: SCOPE_SIGILS[t.scope], path: t.name, start: base + t.nameStart - 1, end: base + t.nameEnd, validated });
  }
}

/**
 * The variable an input macro binds, its first argument: `"$name"` (the name
 * in quotes) or `$name` as written. Spindle validates it for the macros that
 * store a variable; `{unset $x}` and `{computed $x = …}` declare theirs by
 * a `variable` parameter and are found without being validated.
 */
function scanReceiver(token: MacroToken, validated: boolean, add: Add): void {
  const raw = token.rawArgs;
  let length = 0;
  while (length < raw.length && raw[length].trim() !== '') length++;
  const word = raw.slice(0, length);
  const quote = word[0];
  if (quote === '"' || quote === "'") {
    const inner = word.slice(1, word.length > 1 && word.endsWith(quote) ? -1 : undefined);
    const found: VariableReference[] = [];
    scanCode(inner, 'expression', index => token.argsStart + 1 + index, validated, ref => found.push(ref));
    // The quoted form names one `$` variable and nothing else
    if (found.length === 1 && found[0].sigil === '$' && found[0].start === token.argsStart + 1 && found[0].end === token.argsStart + 1 + inner.length) {
      add(found[0]);
    }
  } else if (quote !== '`') {
    scanCode(word, 'expression', index => token.argsStart + index, validated, add);
  }
}

/** What the tooling API knows of the macros of a document, by lowercase name. */
const macroTables = new WeakMap<readonly ToolingMacro[], Map<string, ToolingMacro>>();

function macroNamed(macros: readonly ToolingMacro[], name: string): ToolingMacro | undefined {
  let table = macroTables.get(macros);
  if (!table) {
    table = new Map(macros.map(macro => [macro.name.toLowerCase(), macro]));
    macroTables.set(macros, table);
  }
  return table.get(name.toLowerCase());
}

/**
 * Every variable reference of a passage, read by the tooling API: the pieces
 * of code `passagePieces` finds (displays, expressions, `{do}` bodies,
 * conditions and the macro arguments the parameters declare as code),
 * scanned with `lexJs`; the variable tokens (`{$x}`, in the passage and in
 * the labels and attribute values that hold markup); the selectors; and the
 * variable an input macro binds. Prose, comments and the text of string
 * literals hold none. Offsets are in `markup.content`.
 */
export function collectVariableReferences(
  markup: PassageMarkup,
  storeVarMacros: ReadonlySet<string>,
): VariableReference[] {
  if (!markup.isMarkup) return [];
  const { content } = markup;
  const found = new Map<number, VariableReference>();
  // Spindle reads the references of markup it can tokenize: a passage with a
  // malformed tag has none (the story does not start, whatever its variables)
  const readable = markup.tokenization.errors.length === 0;
  const add: Add = (reference) => {
    reference.validated &&= readable;
    const known = found.get(reference.start);
    if (known) known.validated ||= reference.validated;
    else found.set(reference.start, { ...reference });
  };

  const macros = markup.doc.context.macros;
  const tokenLists: Array<{ tokens: Token[]; readable: boolean }> = [{ tokens: markup.tokens, readable: true }];
  for (const piece of markup.pieces) {
    if (piece.kind === 'code') {
      scanCode(piece.code, piece.goal, index => pieceOffset(piece, index), true, add);
    } else if (piece.kind === 'argument-error') {
      // Arguments that do not have their parameters' forms are scanned as code
      scanCode(content.slice(piece.offset, piece.offset + piece.length), 'expression', index => piece.offset + index, true, add);
    } else if (piece.kind === 'text') {
      // A label or attribute value that cannot be tokenized is not read; the pairing of its tags is another matter
      tokenLists.push({ tokens: piece.tokens, readable: piece.errors.every(error => !isTokenizerError(error.code)) });
    }
  }

  for (const list of tokenLists) {
    const addIn: Add = list.readable ? add : reference => add({ ...reference, validated: false });
    for (const token of list.tokens) {
      switch (token.type) {
        case 'variable':
          addIn({ sigil: SCOPE_SIGILS[token.scope], path: token.name, start: token.nameStart - 1, end: token.nameEnd, validated: true });
          scanSelectors(content, token, false, addIn);
          break;
        case 'expression':
        case 'link':
          scanSelectors(content, token, false, addIn);
          break;
        case 'macro':
          if (!token.isClose) scanMacro(content, token, macros, storeVarMacros, addIn);
          break;
      }
    }
  }
  return [...found.values()].sort((a, b) => a.start - b.start);
}

/** Whether a markup error is the tokenizer's (a malformed tag) and not the pairing's. */
function isTokenizerError(code: MarkupErrorCode): boolean {
  return code !== 'unclosed-block' && code !== 'mismatched-closer' && code !== 'stray-closer' && code !== 'misplaced-branch';
}

function scanMacro(
  content: string,
  token: MacroToken,
  macros: readonly ToolingMacro[],
  storeVarMacros: ReadonlySet<string>,
  add: Add,
): void {
  scanSelectors(content, token, true, add);
  const definition = macroNamed(macros, token.name);
  const binds = storeVarMacros.has(token.name.toLowerCase());
  if (binds || definition?.parameters?.[0]?.type === 'variable') scanReceiver(token, binds, add);
  if (token.rawArgs === '') return;
  // A macro with no declared parameters (a widget, a macro of the project) takes
  // code; the others have their code pieces. Locals are found in either.
  const declared = definition?.parameters !== undefined;
  scanCode(token.rawArgs, 'expression', index => token.argsStart + index, !declared, add, declared ? LOCALS : undefined);
}
