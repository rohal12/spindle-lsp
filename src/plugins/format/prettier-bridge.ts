import type { PrettierLike } from '@rohal12/spindle/tooling';

type Prettier = typeof import('prettier');

let prettier: Promise<Prettier | null> | undefined;

/** Prettier and the options it is given for a document's code, styles and HTML. */
export interface PrettierSetup {
  prettier: PrettierLike;
  options: object;
}

/**
 * The project's Prettier (an optional dependency) and its configuration,
 * resolved from the working directory over `{ tabWidth: 2 }`. Undefined when
 * Prettier is not installed: the code in passages then stays as written.
 */
export async function loadPrettier(): Promise<PrettierSetup | undefined> {
  prettier ??= import('prettier').catch(() => null);
  const p = await prettier;
  if (!p) return undefined;
  try {
    const resolved = await p.resolveConfig(process.cwd());
    return { prettier: p, options: { tabWidth: 2, ...(resolved ?? {}) } };
  } catch {
    return { prettier: p, options: { tabWidth: 2 } };
  }
}
