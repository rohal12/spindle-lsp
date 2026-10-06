import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));

type Evaluate = (
  expr: string,
  variables: Record<string, unknown>,
  temporary: Record<string, unknown>,
  locals?: Record<string, unknown>,
  transient?: Record<string, unknown>,
) => unknown;

/**
 * The installed Spindle's own expression evaluator (src/expression.ts: the
 * sigil transformation, the `new Function` wrapper and its preamble), compiled
 * from the installed source with its store and PRNG imports replaced by a fixed
 * benign empty story state (no visits, no renders, no history). It is only
 * ever called with expressions written by these tests.
 */
function load(): Evaluate {
  const file = join(here, '../../node_modules/@rohal12/spindle/src/expression.ts');
  const js = transformSync(readFileSync(file, 'utf-8'), { loader: 'ts', format: 'cjs' }).code;
  const stubs: Record<string, unknown> = {
    './store': {
      useStoryStore: {
        getState: () => ({ visitCounts: {}, renderCounts: {}, currentPassage: 'Start', history: [], historyIndex: 0, storyData: undefined }),
      },
    },
    './prng': { random: () => 0.5, randomInt: (min: number) => min },
  };
  const module = { exports: {} as { evaluate: Evaluate } };
  new Function('module', 'exports', 'require', js)(module, module.exports, (id: string) => {
    if (!(id in stubs)) throw new Error(`unexpected import ${id} in expression.ts`);
    return stubs[id];
  });
  return module.exports.evaluate;
}

const evaluate = load();

/**
 * Where `{goto}` / `{include}` navigate for these (already `inline`-stripped)
 * arguments, by the components' rule (Goto.tsx, Include.tsx): `String` of the
 * evaluated expression, or, when evaluating throws, the raw text with
 * surrounding quotes stripped. `temporary` is the story's `_` scope.
 */
export function runtimeGotoTarget(args: string, temporary: Record<string, unknown> = {}): string {
  try {
    return String(evaluate(args, {}, temporary, {}, {}));
  } catch {
    return args.replace(/^["']|["']$/g, '');
  }
}
