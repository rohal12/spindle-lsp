/** Configured schema classification; Spindle owns all argument boundaries. */
import { readQuoted, splitArgs } from '@rohal12/spindle/tooling';

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
  /** Variable sigil: $, _, @, or % */
  sigil?: '$' | '_' | '@' | '%';
  /** Dot-access path segments, e.g. $player.health -> ["player", "health"] */
  path?: string[];
}

/** Preserve the runtime's grouped expressions and original UTF-16 source spans. */
export function lexArguments(source: string): Arg[] {
  let from = 0;
  return splitArgs(source).map(text => {
    const start = source.indexOf(text, from);
    from = start + text.length;
    return classifyArgument(text, start);
  });
}

/** Values that cannot be known statically defer to the runtime, without evaluating code. */
export function classifyArgument(text: string, start = 0): Arg {
  const base = { text, start, end: start + text.length };
  if (readQuoted(text, 0)?.end === text.length) return { ...base, type: ArgType.String };
  if (text === 'null') return { ...base, type: ArgType.Null };
  if (text === 'undefined') return { ...base, type: ArgType.Undefined };
  if (text === 'true' || text === 'false') return { ...base, type: ArgType.Boolean };
  if (text === 'NaN') return { ...base, type: ArgType.NaN };
  if (text !== '' && !Number.isNaN(Number(text))) return { ...base, type: ArgType.Number };
  if (/^[$_@%]\w+(?:\.\w+)*$/.test(text)) {
    return { ...base, type: ArgType.Variable, sigil: text[0] as Arg['sigil'], path: text.slice(1).split('.') };
  }
  // These are configured schema types retained for legacy configuration.
  if (text.startsWith('[[') && text.endsWith(']]')) return { ...base, type: ArgType.Link };
  if (/^\[[<>]?img\[/i.test(text) && text.endsWith(']]')) return { ...base, type: ArgType.Image };
  return { ...base, type: /^[-\w]+$/.test(text) ? ArgType.Bareword : ArgType.Expression };
}
