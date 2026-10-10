import { deepTokens } from './tooling.js';
import { interpolationReads } from './interpolation-oracle.js';

/**
 * The `$` and `%` names a macro's arguments read as code: outside ordinary
 * strings (literal text), and inside the `${…}` parts of template literals.
 */
function codeReads(code: string): string[] {
  const reads: string[] = [];
  const outside = code.replace(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g, (_whole, quote: string, body: string) => {
    if (quote === '`') for (const part of body.matchAll(/\$\{([^}]*)\}/g)) reads.push(...Array.from(part[1].matchAll(/[$%]\w+/g), m => m[0]));
    return ' ';
  });
  return [...reads, ...Array.from(outside.matchAll(/[$%]\w+/g), m => m[0])];
}

/**
 * The `$x` / `%t` names (without the sigil, sorted, one per read) the runtime
 * reads from the markup of a passage body: variables and expressions, the
 * arguments of macros read as code, and the `.class#id` selectors, which are
 * interpolated. Labels and attribute values hold markup of their own in
 * Spindle 0.59, so the variables, expressions and macros in them are read too:
 * `deepTokens` finds them, and a string argument of a macro that does not hold
 * markup (`{print "{$x}"}`) is JavaScript, read as none.
 */
export function runtimeVariableReads(text: string): string[] {
  const selectors = (t: { className?: string; id?: string }) => [...interpolationReads(t.className), ...interpolationReads(t.id)];
  const names = deepTokens(text).flatMap(({ token }): string[] => {
    switch (token.type) {
      case 'link':
        return selectors(token);
      case 'variable':
        return [
          ...selectors(token),
          ...(token.scope === 'variable' ? [`$${token.name.split('.')[0]}`] : token.scope === 'transient' ? [`%${token.name.split('.')[0]}`] : []),
        ];
      case 'expression':
        return [...selectors(token), ...codeReads(token.expression)];
      case 'macro':
        return token.isClose ? [] : [...selectors(token), ...codeReads(token.rawArgs)];
      default:
        return [];
    }
  });
  return names.filter(name => name[0] === '$' || name[0] === '%').map(name => name.slice(1)).sort();
}
