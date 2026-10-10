import { evaluatePassageName, passageTarget, transform } from '@rohal12/spindle/tooling';

type Scope = Record<string, unknown>;

/**
 * The runtime's expression evaluator for the tests: Spindle's own sigil
 * transformation (`transform`, public in the tooling API) wrapped in the same
 * `new Function('variables', 'temporary', 'locals', 'transient', ...)` the
 * runtime builds (src/expression.ts), over the scopes the caller passes. The
 * story-state functions the runtime also puts in scope (`visited()`,
 * `random()`, ...) are fixed benign values: no visits, no renders. It is only
 * ever called with expressions written by these tests.
 */
export function evaluate(expr: string, variables: Scope = {}, temporary: Scope = {}, locals: Scope = {}, transient: Scope = {}): unknown {
  const body = transform(expr);
  const stubs = {
    currentPassage: () => undefined, previousPassage: () => undefined,
    visited: () => 0, hasVisited: () => false, hasVisitedAny: () => false, hasVisitedAll: () => false,
    rendered: () => 0, hasRendered: () => false, hasRenderedAny: () => false, hasRenderedAll: () => false,
    random: () => 0.5, randomInt: (min: number) => min,
  };
  const preamble = `const {${Object.keys(stubs).join(',')}}=__fns;`;
  return new Function('variables', 'temporary', 'locals', '__fns', 'transient', `${preamble}return (${body});`)(
    variables, temporary, locals, stubs, transient);
}

/**
 * The passage a `passage` argument of `{goto}` / `{include}` / `{link}` names
 * at run time, by the macros' own rule: a string literal is the name
 * (`passageTarget`), anything else is an expression evaluated in the story's
 * scopes and read with `evaluatePassageName`. Spindle 0.59 has no text
 * fallback: an argument that does not evaluate (`Chapter 2`, a bare name that
 * is no variable) throws when the macro runs and the macro shows an error, so
 * this returns null (no navigation). `temporary` is the story's `_` scope.
 */
export function runtimeGotoTarget(arg: string, temporary: Scope = {}, variables: Scope = {}): string | null {
  const target = passageTarget(arg);
  if (target.kind === 'name') return target.name;
  try {
    return evaluatePassageName(target.expression, expr => evaluate(expr, variables, temporary), { storyData: null, currentPassage: 'Start' });
  } catch {
    return null;
  }
}
