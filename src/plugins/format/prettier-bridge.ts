import type { PrettierLike } from '@rohal12/spindle/tooling';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Prettier = typeof import('prettier');

let prettier: Promise<Prettier | null> | undefined;

/** Prettier and the options it is given for a document's code, styles and HTML. */
export interface PrettierSetup {
  prettier: PrettierLike;
  options: object;
}

/**
 * The project's Prettier (an optional dependency) and its configuration,
 * resolved for the document (or a file in the working directory) over
 * `{ tabWidth: 2 }`. Undefined when
 * Prettier is not installed: the code in passages then stays as written.
 */
export async function loadPrettier(filePath?: string): Promise<PrettierSetup | undefined> {
  prettier ??= import('prettier').catch(() => null);
  const p = await prettier;
  if (!p) return undefined;
  try {
    const path = filePath?.startsWith('file:') ? fileURLToPath(filePath) : filePath;
    const resolved = await p.resolveConfig(path ?? resolve(process.cwd(), 'story.tw'), { useCache: false });
    return { prettier: p, options: { tabWidth: 2, ...(resolved ?? {}) } };
  } catch {
    return { prettier: p, options: { tabWidth: 2 } };
  }
}
