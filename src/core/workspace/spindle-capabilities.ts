import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * What the Spindle a project targets does, for the behaviors that differ
 * between releases. Differences are decided per version, not guessed from
 * source text; each flag names the first release with the behavior and is
 * verified against that release's runtime by `scripts/peer-matrix.sh`
 * (see docs/reviews/2026-10-06-peer-range.md).
 */
export interface SpindleCapabilities {
  /** The target version (`major.minor.patch`), or undefined if undetectable. */
  version: string | undefined;
  /** Where the version came from. */
  source: 'installed' | 'story-data' | 'default';
  /**
   * Spindle >= 0.43.0: transients (`%name`, StoryTransients). The LSP's
   * floor; below it the runtime rejects `%` syntax.
   */
  supported: boolean;
  /**
   * Spindle >= 0.50.1: startup validation (`validatePassages`) checks only
   * references the passage executes (tokenizer-based: `{$v}`, expressions,
   * macro arguments, `{do}` bodies, input-macro variable names and
   * attribute interpolations), not prose, plain strings or comments. Below
   * it, the raw passage text is scanned.
   */
  executableRefsOnly: boolean;
  /**
   * Spindle >= 0.51.1: a number, string or boolean exposes its wrapper's
   * members to startup validation (`$n.toFixed`, `$s.length`); below it any
   * field of a primitive is an error.
   */
  primitiveMembers: boolean;
}

/** The oldest Spindle the LSP supports: the one that introduced transients. */
export const MINIMUM_SPINDLE_VERSION = '0.43.0';
/** First release whose startup validation scans executable references only. */
export const EXECUTABLE_REFS_VERSION = '0.50.1';
/** First release whose startup validation allows primitive wrapper members. */
export const PRIMITIVE_MEMBERS_VERSION = '0.51.1';

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

/**
 * The behavior pinned by the Spindle 0.45.1 contract tests, used when no
 * version can be detected: raw-text validation, primitives have no members,
 * transients supported (no unsupported-version warning is raised).
 */
export const DEFAULT_CAPABILITIES: SpindleCapabilities = {
  version: undefined,
  source: 'default',
  supported: true,
  executableRefsOnly: false,
  primitiveMembers: false,
};

/** The capabilities of a Spindle `version`; the default ones if it does not parse. */
export function capabilitiesForVersion(
  version: string,
  source: 'installed' | 'story-data' = 'installed',
): SpindleCapabilities {
  const triple = parseSpindleVersion(version);
  if (!triple) return DEFAULT_CAPABILITIES;
  return {
    version: triple.join('.'),
    source,
    supported: atLeast(triple, MINIMUM_SPINDLE_VERSION),
    executableRefsOnly: atLeast(triple, EXECUTABLE_REFS_VERSION),
    primitiveMembers: atLeast(triple, PRIMITIVE_MEMBERS_VERSION),
  };
}

/**
 * The version of the @rohal12/spindle installed for the project: the first
 * `node_modules/@rohal12/spindle/package.json` found in `startDir` or an
 * ancestor, the way Node resolves a package. This is the copy the project's
 * builtin macros are read from. Undefined if none is installed or readable.
 */
export function readInstalledSpindleVersion(startDir: string): string | undefined {
  const target = join('node_modules', '@rohal12', 'spindle', 'package.json');
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, target);
    if (existsSync(candidate)) {
      try {
        const version: unknown = (JSON.parse(readFileSync(candidate, 'utf-8')) as { version?: unknown }).version;
        return typeof version === 'string' && parseSpindleVersion(version) ? version : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolve the target Spindle. In order: the `installed` version (see
 * readInstalledSpindleVersion), then the `format-version` the project's
 * StoryData declares, then the default behavior. The LSP's own copy of
 * Spindle is deliberately not consulted: it is a development or peer install
 * that says nothing about the story's runtime.
 */
export function resolveSpindleCapabilities(
  installed: string | undefined,
  storyDataFormatVersion?: string,
): SpindleCapabilities {
  if (installed && parseSpindleVersion(installed)) return capabilitiesForVersion(installed, 'installed');
  if (storyDataFormatVersion && parseSpindleVersion(storyDataFormatVersion)) {
    return capabilitiesForVersion(storyDataFormatVersion, 'story-data');
  }
  return DEFAULT_CAPABILITIES;
}

/** Message for the diagnostic and the startup log when the target is below the floor. */
export function unsupportedVersionMessage(caps: SpindleCapabilities): string {
  return `Spindle ${caps.version} is older than ${MINIMUM_SPINDLE_VERSION}, the oldest version spindle-lsp supports. ` +
    "It rejects transients (`%name`, StoryTransients) and spindle-lsp's checks assume 0.43.0 or newer. " +
    `Update @rohal12/spindle to ${MINIMUM_SPINDLE_VERSION} or later.`;
}
