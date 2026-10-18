import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { glob } from 'glob';

/** Existing paths are literal, even when their names contain glob syntax. */
export async function resolveFiles(pattern: string, cwd: string): Promise<string[]> {
  let input = pattern;
  let directory = cwd;
  const literal = resolve(cwd, pattern);
  try {
    const stat = statSync(literal);
    if (stat.isFile()) return [literal];
    if (stat.isDirectory()) {
      directory = literal;
      input = '**/*.{tw,twee}';
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  return [...new Set(await glob(input, { cwd: directory, absolute: true, nodir: true }))];
}

/** Read the whole input batch before analysis or writes; failures retain their path. */
export function readFileContents(files: readonly string[]): Map<string, string> {
  return new Map(files.map(file => [file, readFileSync(file, 'utf8')]));
}

/** Resolve overlapping CLI arguments once, using the same policy as MCP. */
export async function resolveInputs(patterns: readonly string[], cwd: string): Promise<string[]> {
  const files = await Promise.all(patterns.map(pattern => resolveFiles(pattern, cwd)));
  return [...new Set(files.flat())];
}

/** Path relative to `cwd` for files inside it; preserve absolute paths outside it. */
export function relativeTo(cwd: string, filePath: string): string {
  const rel = relative(cwd, filePath);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? filePath : rel;
}
