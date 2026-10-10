/**
 * NEEDS UPSTREAM API. Spindle 0.59 resolves text-only markup (HTML attribute
 * values, link labels, macro labels) in `interpolation.ts`, which is not part
 * of the public API and cannot be imported under vitest (it pulls in the
 * Peggy grammar). Spindle's tooling API does not export an evaluator for
 * text-mode markup, and `@rohal12/spindle/headless` needs a DOM that this
 * repository's test environment does not have.
 *
 * What this module does instead is the closest public equivalent: the text
 * mode of the public tokenizer (`tokenizeMarkupTolerant(text, { text: true })`),
 * its pairing (`pairMarkup`) and its sigil transformation (`transform`),
 * evaluated here following interpolation.ts for the node kinds with a simple
 * rule (text, variables, expressions, `{if}`/`{elseif}`/`{else}`, `{print}`).
 * A macro without a text form, and the macros whose text form is not modelled
 * (`{for}`, `{switch}`), throw, exactly as the runtime reports a macro without
 * a text form. Missing capability: a pure `interpolate(template, scopes)` (or
 * `renderText`) in `@rohal12/spindle/tooling`.
 */
import { pairMarkup, tokenizeMarkupTolerant, type PairedNode } from '@rohal12/spindle/tooling';
import { evaluate } from './expression-oracle.js';

type Scope = Record<string, unknown>;
interface Scopes { variables: Scope; temporary: Scope; locals: Scope; transient: Scope }

const display = (value: unknown): string => (value == null ? '' : String(value));

/**
 * A scope whose every name exists (as an own entry, which is how the runtime
 * reads a variable: `ownValue`) and reads as `value`; `record` is called with
 * the name of each read (`get`), once per read.
 */
export function everyNameScope(value: unknown, record?: (name: string) => void): Scope {
  return new Proxy({}, {
    get: (_target, key) => {
      if (typeof key !== 'string') return undefined;
      record?.(key);
      return value;
    },
    has: () => true,
    getOwnPropertyDescriptor: (_target, key) =>
      (typeof key === 'string' ? { value: undefined, writable: true, enumerable: true, configurable: true } : undefined),
  });
}

/** The `$x` / `_x` / `@x` / `%x` names an interpolation reads from `template`, in the order it reads them. */
export function interpolationReads(template: string | undefined): string[] {
  if (template === undefined) return [];
  const seen: string[] = [];
  const scope = (prefix: string) => everyNameScope(undefined, name => seen.push(prefix + name));
  try {
    interpolate(template, scope('$'), scope('_'), scope('@'), scope('%'));
  } catch {
    // An expression that does not parse reads nothing
  }
  return seen;
}

/** Whether a string may contain markup (anything but plain text), as the runtime tests it. */
export function hasInterpolation(s: string): boolean {
  return s.includes('{') || s.includes('}');
}

function nodes(list: PairedNode[], scopes: Scopes): string {
  return list.map(node => one(node, scopes)).join('');
}

function ownValue(store: Scope, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : undefined;
}

function one({ token, body }: PairedNode, scopes: Scopes): string {
  const ev = (expr: string) => evaluate(expr, scopes.variables, scopes.temporary, scopes.locals, scopes.transient);
  switch (token.type) {
    case 'text':
      return token.value;
    case 'variable': {
      const [root, ...path] = token.name.split('.');
      const store = scopes[token.scope === 'variable' ? 'variables' : token.scope === 'temporary' ? 'temporary' : token.scope === 'transient' ? 'transient' : 'locals'];
      let value: unknown = ownValue(store, root);
      for (const key of path) {
        if (value == null) return '';
        value = (value as Record<string, unknown>)[key];
      }
      return display(value);
    }
    case 'expression':
      return display(ev(token.expression));
    case 'html':
      return body ? nodes(body.children, scopes) : '';
    case 'link':
      throw new Error('a link has no text form (the test oracle does not model it)');
    case 'macro': {
      const name = token.name.toLowerCase();
      if (name === 'print') return display(ev(token.rawArgs));
      if (name === 'if') {
        if (ev(token.rawArgs)) return nodes(body?.children ?? [], scopes);
        for (const branch of body?.branches ?? []) {
          const branchName = branch.tag.name.toLowerCase();
          if (branchName === 'else' || ev(branch.tag.rawArgs)) return nodes(branch.children, scopes);
        }
        return '';
      }
      throw new Error(`{${token.name}} has no text form in the test oracle (needs upstream API: only if/print/variables/expressions are modelled)`);
    }
  }
}

/**
 * Evaluate text-only markup to a string, throwing the first error met
 * (interpolation.ts `interpolate`). See the module comment for what is modelled.
 */
export function interpolate(
  template: string,
  variables: Scope = {}, temporary: Scope = {}, locals: Scope = {}, transient: Scope = {},
): string {
  if (!hasInterpolation(template)) return template;
  const { tokens, errors } = tokenizeMarkupTolerant(template, { text: true });
  if (errors.length > 0) throw errors[0];
  const paired = pairMarkup(tokens, { source: template });
  if (paired.errors.length > 0) throw new Error(paired.errors[0].message);
  return nodes(paired.nodes, { variables, temporary, locals, transient });
}
