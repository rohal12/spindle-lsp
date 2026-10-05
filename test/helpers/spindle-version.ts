import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilitiesForVersion } from '../../src/core/workspace/spindle-capabilities.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The version of the @rohal12/spindle the tests import their oracle from
 * (`node_modules/@rohal12/spindle/src/...`), which scripts/peer-matrix.sh
 * swaps for the version under test.
 */
export const INSTALLED_SPINDLE_VERSION: string = (
  JSON.parse(readFileSync(join(here, '../../node_modules/@rohal12/spindle/package.json'), 'utf-8')) as { version: string }
).version;

/** The LSP's view of that installed runtime. */
export const INSTALLED_CAPABILITIES = capabilitiesForVersion(INSTALLED_SPINDLE_VERSION);
