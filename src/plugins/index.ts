import type { SpindlePlugin } from '../core/plugin/plugin-api.js';
import { diagnosticsPlugin } from './diagnostics.js';
import { completionsPlugin } from './completions.js';
import { hoverPlugin } from './hover.js';
import { signaturePlugin } from './signature.js';
import { definitionPlugin } from './definition.js';
import { referencesPlugin } from './references.js';
import { renamePlugin } from './rename.js';
import { codeLensPlugin } from './code-lens.js';
import { inlayHintsPlugin } from './inlay-hints.js';
import { semanticTokensPlugin } from './semantic-tokens.js';
import { codeActionsPlugin } from './code-actions.js';

/**
 * Registry of all feature plugins.
 */
export const allPlugins: SpindlePlugin[] = [
  diagnosticsPlugin,
  completionsPlugin,
  hoverPlugin,
  signaturePlugin,
  definitionPlugin,
  referencesPlugin,
  renamePlugin,
  codeLensPlugin,
  inlayHintsPlugin,
  semanticTokensPlugin,
  codeActionsPlugin,
];
