import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { buildAST } from '../../node_modules/@rohal12/spindle/src/markup/ast.js';
import { tokenize } from './tooling.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface LinkRead {
  display: string;
  passage: string | null;
}

/**
 * The installed runtime's own `parseArgs` of the `{link}` macro
 * (components/macros/MacroLink.tsx): the function's source is cut out of the
 * component (which needs a DOM and preact to import), compiled and called.
 */
function loadParseArgs(): (rawArgs: string) => LinkRead {
  const file = join(here, '../../node_modules/@rohal12/spindle/src/components/macros/MacroLink.tsx');
  const source = readFileSync(file, 'utf-8');
  const start = source.indexOf('function parseArgs(');
  const end = source.indexOf('\nfunction ', start + 1);
  if (start === -1 || end === -1) throw new Error('MacroLink.parseArgs not found in the installed Spindle');
  const js = transformSync(source.slice(start, end), { loader: 'ts' }).code;
  return new Function(`${js}\nreturn parseArgs;`)() as (rawArgs: string) => LinkRead;
}

export const runtimeParseLinkArgs = loadParseArgs();

/** What the runtime's link macro reads from `{link ...rawArgs}`. */
export function runtimeLinkMacro(rawArgs: string): LinkRead {
  return runtimeParseLinkArgs(rawArgs);
}

/**
 * What the runtime's link macro reads for the single bracket link in `text`:
 * the tokenizer's link token, buildAST's `{link}` node, then parseArgs.
 */
export function runtimeBracketLink(text: string): (LinkRead & { token: { display: string; target: string } }) | null {
  const token = tokenize(text).find(t => t.type === 'link');
  if (!token || token.type !== 'link') return null;
  const node = buildAST([token])[0];
  if (node.type !== 'macro') throw new Error('a link token is not a macro node');
  return { ...runtimeParseLinkArgs(node.rawArgs), token: { display: token.display, target: token.target } };
}
