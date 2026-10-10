import { variableReferences } from '@rohal12/spindle/tooling';
import type { PassageMarkup } from '../markup/passage-markup.js';

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

/**
 * Every `$` and `%` variable reference of a passage, with its path and span
 * in `markup.content`, as the tooling API's `variableReferences` returns them
 * with `all: true`: the ones the story start checks (displays, expressions,
 * conditions, `{do}` bodies, the code arguments of macros, the variable an
 * input macro binds, labels and attribute values) and the ones it does not
 * (the variable a macro declares, `{unset $x}`, and the `{$name}` of a
 * selector). Prose, comments and the text of string literals hold none.
 */
export function collectVariableReferences(markup: PassageMarkup): VariableReference[] {
  if (!markup.isMarkup) return [];
  return variableReferences(markup.content, markup.doc.context.macros, { all: true }).map(ref => ({
    sigil: ref.sigil,
    name: ref.name,
    path: [ref.name, ...ref.path].join('.'),
    start: ref.start,
    end: ref.end,
  }));
}
