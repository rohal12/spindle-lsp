import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { findProjectFiles, isExcludedProjectFile } from './macro-sources.js';

/**
 * Existing files are literal, even when their names contain glob syntax or
 * lie in excluded directories. Directory and glob discovery use the same
 * project exclusions as the LSP scan.
 */
export async function resolveFiles(pattern: string, cwd: string): Promise<string[]> {
  let input = pattern;
  let directory = cwd;
  const literal = resolve(cwd, pattern);
  try {
    const stat = statSync(literal);
    if (stat.isFile()) return [literal];
    if (stat.isDirectory()) {
      // Changing the scan root must not hide excluded ancestor segments.
      if (isExcludedProjectFile(literal, cwd)) return [];
      directory = literal;
      input = '**/*.{tw,twee}';
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  return [...new Set(await findProjectFiles(directory, input))];
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
