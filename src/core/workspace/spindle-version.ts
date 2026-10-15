import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The oldest Spindle the LSP supports. spindle-lsp is built on the tooling
 * API of this release (`@rohal12/spindle/tooling`): the lexer, tokenizer and
 * argument rules it exports are the ones the runtime of this release reads
 * passages with, so a project on an older Spindle can disagree with them.
 */
export const MINIMUM_SPINDLE_VERSION = '0.60.0';

/** The Spindle a project targets, and whether the LSP supports it. */
export interface SpindleTarget {
  /** The target version (`major.minor.patch`), or undefined if undetectable. */
  version: string | undefined;
  /** Where the version came from. */
  source: 'installed' | 'story-data' | 'default';
  /** False when the version is known and older than {@link MINIMUM_SPINDLE_VERSION}. */
  supported: boolean;
}

type Triple = [number, number, number];

/** `major.minor.patch` of a version string (a prerelease or build suffix is ignored). */
export function parseSpindleVersion(text: string): Triple | undefined {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?\s*$/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function atLeast(version: Triple, minimum: string): boolean {
  const min = parseSpindleVersion(minimum)!;
  for (let i = 0; i < 3; i++) {
    if (version[i] !== min[i]) return version[i] > min[i];
  }
  return true;
}

/** No version detected: nothing to warn about. */
export const DEFAULT_TARGET: SpindleTarget = { version: undefined, source: 'default', supported: true };

/**
 * The version of the @rohal12/spindle installed for the project: the first
 * `node_modules/@rohal12/spindle/package.json` found in `startDir` or an
 * ancestor, the way Node resolves a package. This is the copy the project's
 * builtin macros are read from. Undefined if none is installed or readable.
 *
 * The copy is the project's only when a `package.json` in the directory that
 * holds that `node_modules`, or in a directory between it and `startDir`,
 * declares `@rohal12/spindle` (in any dependency field). Otherwise another
 * package put it there, such as `npm i @rohal12/spindle-lsp`, whose own
 * Spindle npm hoists into a project that has none: it says nothing about the
 * Spindle the story runs on, and counts as not installed.
 */
export function readInstalledSpindleVersion(startDir: string): string | undefined {
  const target = join('node_modules', '@rohal12', 'spindle', 'package.json');
  let declared = false;
  return findUp(startDir, dir => {
    declared ||= declaresSpindle(readPackageJson(join(dir, 'package.json')));
    const candidate = join(dir, target);
    if (!existsSync(candidate)) return undefined;
    return { version: declared ? spindleVersionOf(readPackageJson(candidate)) : undefined };
  });
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

function declaresSpindle(pkg: PackageJson | undefined): boolean {
  return DEPENDENCY_FIELDS.some(field => {
    const deps = pkg?.[field];
    return typeof deps === 'object' && deps !== null && Object.hasOwn(deps, '@rohal12/spindle');
  });
}

/**
 * The version of the @rohal12/spindle package that contains `file` (a path or
 * a `file:` URL, such as a resolved module): the nearest `package.json` above
 * it that has a name, if that one is @rohal12/spindle's. Undefined otherwise.
 */
export function readSpindlePackageVersion(file: string): string | undefined {
  const path = file.startsWith('file:') ? fileURLToPath(file) : file;
  return findUp(dirname(path), dir => {
    const candidate = join(dir, 'package.json');
    if (!existsSync(candidate)) return undefined;
    const pkg = readPackageJson(candidate);
    // A package.json without a name (`{"type": "module"}` in a build folder)
    // is not the package root.
    if (pkg?.name === undefined) return undefined;
    return { version: pkg.name === '@rohal12/spindle' ? spindleVersionOf(pkg) : undefined };
  });
}

/** Walk from `startDir` up to the root until `visit` returns a result. */
function findUp(
  startDir: string,
  visit: (dir: string) => { version: string | undefined } | undefined,
): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const found = visit(dir);
    if (found) return found.version;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

type PackageJson = { name?: unknown; version?: unknown } & {
  [field in (typeof DEPENDENCY_FIELDS)[number]]?: unknown;
};

function readPackageJson(file: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as PackageJson;
  } catch {
    return undefined;
  }
}

function spindleVersionOf(pkg: { version?: unknown } | undefined): string | undefined {
  const version = pkg?.version;
  return typeof version === 'string' && parseSpindleVersion(version) ? version : undefined;
}

/**
 * Resolve the target Spindle. In order: the `installed` version (see
 * readInstalledSpindleVersion), then the `format-version` the project's
 * StoryData declares, then nothing. The LSP's own copy of Spindle is
 * deliberately not consulted: it is the build-time copy and says nothing
 * about the story's runtime.
 */
export function resolveSpindleTarget(installed: string | undefined, storyDataFormatVersion?: string): SpindleTarget {
  for (const [version, source] of [[installed, 'installed'], [storyDataFormatVersion, 'story-data']] as const) {
    const triple = version ? parseSpindleVersion(version) : undefined;
    if (triple) return { version: triple.join('.'), source, supported: atLeast(triple, MINIMUM_SPINDLE_VERSION) };
  }
  return DEFAULT_TARGET;
}

/** Message for the diagnostic and the startup log when the target is below the floor. */
export function unsupportedVersionMessage(target: SpindleTarget): string {
  return `Spindle ${target.version} is older than ${MINIMUM_SPINDLE_VERSION}, the oldest version spindle-lsp supports. ` +
    `Update @rohal12/spindle to ${MINIMUM_SPINDLE_VERSION} or later.`;
}
