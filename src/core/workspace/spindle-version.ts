import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The oldest Spindle the LSP supports. spindle-lsp is built on the tooling
 * API of this release (`@rohal12/spindle/tooling`): the lexer, tokenizer and
 * argument rules it exports are the ones the runtime of this release reads
 * passages with, so a project on an older Spindle can disagree with them.
 */
export const MINIMUM_SPINDLE_VERSION = '0.59.20';

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

// ---------------------------------------------------------------------------
// Compatibility shim, removed with the parsers that still read it.
//
// Before the tooling API, behavior differed between Spindle releases and the
// LSP carried per-release flags. The minimum release now has the modern
// behavior throughout, so every flag is true; the parsers that still take them
// are being replaced by the tooling API's.
// ---------------------------------------------------------------------------

/** @deprecated Every flag is true; delete with the code that reads them. */
export interface SpindleCapabilities extends SpindleTarget {
  executableRefsOnly: true;
  primitiveMembers: true;
  linkQuoteEscapes: true;
  rawDoBodies: true;
  stringAwareBraces: true;
  includeInlineScoped: true;
}

const MODERN = {
  executableRefsOnly: true,
  primitiveMembers: true,
  linkQuoteEscapes: true,
  rawDoBodies: true,
  stringAwareBraces: true,
  includeInlineScoped: true,
} as const;

/** @deprecated */
export const DEFAULT_CAPABILITIES: SpindleCapabilities = { ...DEFAULT_TARGET, ...MODERN };

/** @deprecated */
export function capabilitiesForVersion(version: string, source: 'installed' | 'story-data' = 'installed'): SpindleCapabilities {
  const target = resolveSpindleTarget(source === 'installed' ? version : undefined, source === 'story-data' ? version : undefined);
  return { ...target, ...MODERN };
}

/** @deprecated */
export function resolveSpindleCapabilities(installed: string | undefined, storyDataFormatVersion?: string): SpindleCapabilities {
  return { ...resolveSpindleTarget(installed, storyDataFormatVersion), ...MODERN };
}
