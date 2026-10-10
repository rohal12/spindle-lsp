import {
  SIGIL_SCOPES,
  lexJs,
  tokenizeMarkupTolerant,
  variableReferences,
  type MacroToken,
  type ToolingMacro,
  type VariableScope,
} from '@rohal12/spindle/tooling';
import type { PassageMarkup } from '../markup/passage-markup.js';
import { markupTokens } from '../markup/tokens.js';

/** A `$var.path` / `%var.path` reference a passage evaluates. */
export interface VariableReference {
  sigil: '$' | '%';
  /** The variable, without the sigil or any property path. */
  name: string;
  /** The dotted path after the sigil: `player.stats.hp`. */
  path: string;
  /** Offsets in the passage's `content` of the sigil and of the end of the path. */
  start: number;
  end: number;
}

const SCOPE_SIGILS = Object.fromEntries(
  Object.entries(SIGIL_SCOPES).map(([sigil, scope]) => [scope, sigil]),
) as Record<VariableScope, string>;

/** The macros of a document by lowercase name. */
const macroTables = new WeakMap<readonly ToolingMacro[], Map<string, ToolingMacro>>();

function macroNamed(macros: readonly ToolingMacro[], name: string): ToolingMacro | undefined {
  let table = macroTables.get(macros);
  if (!table) {
    table = new Map(macros.map(macro => [macro.name.toLowerCase(), macro]));
    macroTables.set(macros, table);
  }
  return table.get(name.toLowerCase());
}

/** The `{$name}` interpolations of the `.class#id` selectors of a token. */
function selectorReferences(
  content: string,
  token: { selectorsStart?: number; selectorsEnd?: number },
  add: (reference: VariableReference) => void,
): void {
  if (token.selectorsStart === undefined || token.selectorsEnd === undefined) return;
  const base = token.selectorsStart;
  const { tokens } = tokenizeMarkupTolerant(content.slice(base, token.selectorsEnd), { text: true });
  for (const t of tokens) {
    if (t.type !== 'variable' || (SCOPE_SIGILS[t.scope] !== '$' && SCOPE_SIGILS[t.scope] !== '%')) continue;
    add({ sigil: SCOPE_SIGILS[t.scope] as '$' | '%', name: t.name.split('.')[0], path: t.name, start: base + t.nameStart - 1, end: base + t.nameEnd });
  }
}

/**
 * The variable a macro with a `variable` parameter names in its first
 * argument (`{unset $x}`, `{computed "$x" = ...}`): `$name` or `"$name"` as
 * written. `variableReferences` does not return it.
 */
function receiverReference(token: MacroToken, add: (reference: VariableReference) => void): void {
  const raw = token.rawArgs;
  let length = 0;
  while (length < raw.length && raw[length].trim() !== '') length++;
  const word = raw.slice(0, length);
  const quote = word[0];
  if (quote === '`') return;
  const quoted = quote === '"' || quote === "'";
  const inner = quoted ? word.slice(1, word.length > 1 && word.endsWith(quote) ? -1 : undefined) : word;
  const base = token.argsStart + (quoted ? 1 : 0);
  lexJs(inner, {
    variable(sigil, name, index) {
      if (sigil !== '$' && sigil !== '%') return;
      let end = index + 1 + name.length;
      while (inner[end] === '.' && /\w/.test(inner[end + 1] ?? '')) {
        end++;
        while (/\w/.test(inner[end] ?? '')) end++;
      }
      // The quoted form names one variable and nothing else
      if (quoted && (index !== 0 || end !== inner.length)) return;
      add({ sigil, name, path: inner.slice(index + 1, end), start: base + index, end: base + end });
    },
  });
}

/**
 * Every `$` and `%` variable reference of a passage, with its path and span
 * in `markup.content`: the ones the tooling API's `variableReferences` finds
 * where the story start looks (displays, expressions, conditions, `{do}`
 * bodies, the code arguments of macros, the variable an input macro binds,
 * labels and attribute values), and what it does not return: the variable a
 * macro declares (`{unset $x}`) and the `{$name}` of a selector. Prose,
 * comments and the text of string literals hold none.
 */
export function collectVariableReferences(markup: PassageMarkup): VariableReference[] {
  if (!markup.isMarkup) return [];
  const { content } = markup;
  const macros = markup.doc.context.macros;
  const found = new Map<number, VariableReference>();

  for (const ref of variableReferences(content, macros)) {
    found.set(ref.start, {
      sigil: ref.sigil,
      name: ref.name,
      path: [ref.name, ...ref.path].join('.'),
      start: ref.start,
      end: ref.end,
    });
  }

  const add = (reference: VariableReference) => {
    if (!found.has(reference.start)) found.set(reference.start, reference);
  };
  for (const token of markupTokens(markup)) {
    if (token.type === 'macro' && token.isClose) continue;
    if (token.type !== 'text' && token.type !== 'html') selectorReferences(content, token, add);
    if (token.type === 'macro' && macroNamed(macros, token.name)?.parameters?.[0]?.type === 'variable') receiverReference(token, add);
  }
  return [...found.values()].sort((a, b) => a.start - b.start);
}
