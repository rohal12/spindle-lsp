import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { glob } from 'glob';
import type { Path } from 'glob';

import { findConfigFile } from './config-loader.js';

/**
 * JavaScript/TypeScript files scanned for `Story.defineMacro({...})` calls.
 */
const MACRO_SOURCE_PATTERN = /\.[cm]?[jt]s$/i;

/** Glob matching {@link MACRO_SOURCE_PATTERN}. */
export const MACRO_SOURCE_GLOB = '**/*.{js,cjs,mjs,ts,cts,mts}';

/**
 * Directories whose JS/TS files are not project macro sources:
 * dependencies and build output (bundles would duplicate the project's own
 * definitions). Hidden entries (`.git`, `.storybook`, `.eslintrc.js`, ...)
 * are excluded as well.
 */
const EXCLUDED_DIRS = ['node_modules', 'dist', 'build'];

/** Whether a path segment names a hidden or excluded entry. */
function isExcludedSegment(segment: string): boolean {
  return EXCLUDED_DIRS.includes(segment)
    || (segment.startsWith('.') && segment !== '.' && segment !== '..');
}

/** Whether a URI or path names a JS/TS macro source file. */
export function isMacroSource(uriOrPath: string): boolean {
  return MACRO_SOURCE_PATTERN.test(uriOrPath);
}

/**
 * Whether a JS/TS file is hidden or lies inside a hidden or excluded
 * directory (relative to `root`, or anywhere in the path if no root is
 * given). The single source of truth for both the initial scan
 * ({@link findMacroSourceFiles}) and file watcher events.
 */
export function isExcludedMacroSource(path: string, root?: string): boolean {
  return (root ? relative(root, path) : path)
    .split(/[\\/]/)
    .some(isExcludedSegment);
}

/**
 * Find the JS/TS macro source files under `root` (absolute paths),
 * skipping those matched by {@link isExcludedMacroSource}.
 */
export function findMacroSourceFiles(root: string): Promise<string[]> {
  return findProjectFiles(root, MACRO_SOURCE_GLOB);
}

/**
 * Find the files matching `pattern` under `root` (absolute paths), skipping
 * hidden entries, dependencies and build output like
 * {@link findMacroSourceFiles}.
 */
export function findProjectFiles(root: string, pattern: string): Promise<string[]> {
  const excluded = (p: Path): boolean => isExcludedMacroSource(p.fullpath(), root);
  return glob(pattern, {
    cwd: root,
    absolute: true,
    nodir: true,
    // Hidden entries are excluded by the predicate, not by glob's default
    dot: true,
    ignore: { ignored: excluded, childrenIgnored: excluded },
  });
}

/** Whether `path` is `dir` or lies inside it (whole segments, not a string prefix). */
function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The deepest directory containing all of the given (absolute) files. */
export function commonDirectory(files: string[]): string {
  return files.map(f => dirname(f)).reduce((a, b) => {
    while (!isWithin(b, a) && dirname(a) !== a) a = dirname(a);
    return a;
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
