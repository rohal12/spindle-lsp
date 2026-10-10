import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilitiesForVersion } from '../../src/core/workspace/spindle-version.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The version of the @rohal12/spindle the tests take their oracle from: the
 * devDependency, through its public `@rohal12/spindle/tooling` entry point
 * (see test/helpers/tooling.ts). spindle-lsp supports 0.59.20 and later; the
 * suite no longer runs against other releases.
 */
export const INSTALLED_SPINDLE_VERSION: string = (
  JSON.parse(readFileSync(join(here, '../../node_modules/@rohal12/spindle/package.json'), 'utf-8')) as { version: string }
).version;

/**
 * The LSP's view of that installed runtime. A shim kept while `src/` still
 * carries per-release capability flags (every flag is true on the supported
 * releases); delete it with them.
 */
export const INSTALLED_CAPABILITIES = capabilitiesForVersion(INSTALLED_SPINDLE_VERSION);
