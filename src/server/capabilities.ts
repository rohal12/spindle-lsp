import { TextDocumentSyncKind } from 'vscode-languageserver';
import type { ServerCapabilities } from 'vscode-languageserver';
import type { SpindlePlugin } from '../core/plugin/plugin-api.js';
import { mergeCapabilities } from '../core/plugin/plugin-loader.js';

/**
 * Build the full ServerCapabilities object by combining the base capabilities
 * (text document sync) with all plugin-contributed capabilities.
 */
export function buildCapabilities(
  plugins: SpindlePlugin[],
): ServerCapabilities {
  const pluginCaps = mergeCapabilities(plugins);
  return {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    ...pluginCaps,
  };
}
