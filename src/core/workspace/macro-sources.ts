import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { glob } from 'glob';

import { findConfigFile } from './config-loader.js';

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

/** Entries (besides a spindle config file) that mark a project's root. */
const PROJECT_ROOT_MARKERS = ['package.json', '.git'];

/**
 * The root of the project containing `dir`: the nearest directory, from
 * `dir` upwards, holding a spindle config file, a package.json or .git.
 * Falls back to `dir` itself if there is none.
 */
export function findProjectRoot(dir: string): string {
  for (let search = dir; ; search = dirname(search)) {
    if (findConfigFile(search)
      || PROJECT_ROOT_MARKERS.some(marker => existsSync(join(search, marker)))) {
      return search;
    }
    if (dirname(search) === search) return dir;
  }
}

/**
 * Add the JS/TS macro sources of the project containing `dir` to
 * `contents` (file URI to text), keeping documents already present.
 * Used by one-shot checks (CLI, MCP), which load these files for macro
 * discovery only.
 */
export async function addProjectMacroSources(
  contents: Map<string, string>,
  dir: string,
): Promise<void> {
  for (const filePath of await findMacroSourceFiles(findProjectRoot(dir))) {
    const uri = pathToFileURL(filePath).toString();
    if (contents.has(uri)) continue;
    try {
      contents.set(uri, readFileSync(filePath, 'utf-8'));
    } catch {
      // Skip unreadable files
    }
  }
}
