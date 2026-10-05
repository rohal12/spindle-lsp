import { relative } from 'node:path';
import { glob } from 'glob';

/**
 * JavaScript/TypeScript files scanned for `Story.defineMacro({...})` calls.
 */
const MACRO_SOURCE_PATTERN = /\.[cm]?[jt]s$/i;

/** Glob matching {@link MACRO_SOURCE_PATTERN}. */
export const MACRO_SOURCE_GLOB = '**/*.{js,cjs,mjs,ts,cts,mts}';

/**
 * Directories whose JS/TS files are not project macro sources:
 * dependencies, VCS metadata and build output (bundles would duplicate
 * the project's own definitions).
 */
const EXCLUDED_DIRS = ['node_modules', '.git', 'dist', 'build'];

const MACRO_SOURCE_IGNORE = EXCLUDED_DIRS.map(dir => `**/${dir}/**`);

/** Whether a URI or path names a JS/TS macro source file. */
export function isMacroSource(uriOrPath: string): boolean {
  return MACRO_SOURCE_PATTERN.test(uriOrPath);
}

/**
 * Whether a JS/TS file lies inside an excluded directory
 * (relative to `root`, or anywhere in the path if no root is given).
 */
export function isExcludedMacroSource(path: string, root?: string): boolean {
  return (root ? relative(root, path) : path)
    .split(/[\\/]/)
    .some(segment => EXCLUDED_DIRS.includes(segment));
}

/**
 * Find the JS/TS macro source files under `root` (absolute paths),
 * skipping dependency and build-output directories.
 */
export function findMacroSourceFiles(root: string): Promise<string[]> {
  return glob(MACRO_SOURCE_GLOB, {
    cwd: root,
    absolute: true,
    nodir: true,
    ignore: MACRO_SOURCE_IGNORE,
  });
}
