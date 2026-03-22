import type { ServerCapabilities } from 'vscode-languageserver';
import type { SpindlePlugin, SpindleConfig } from './plugin-api.js';

/**
 * Filter plugins based on the disabled list in config.
 * Returns only plugins whose id is NOT in `config.disabledPlugins`.
 */
export function loadPlugins(
  allPlugins: SpindlePlugin[],
  config: SpindleConfig,
): SpindlePlugin[] {
  const disabled = new Set(config.disabledPlugins ?? []);
  return allPlugins.filter((p) => !disabled.has(p.id));
}

/**
 * Deep-merge capabilities from all plugins into a single ServerCapabilities object.
 *
 * For boolean capabilities, any plugin providing `true` wins.
 * For object capabilities, properties are merged (later plugins override on collision).
 */
export function mergeCapabilities(
  plugins: SpindlePlugin[],
): Partial<ServerCapabilities> {
  const merged: Record<string, unknown> = {};

  for (const plugin of plugins) {
    for (const [key, value] of Object.entries(plugin.capabilities)) {
      const existing = merged[key];
      if (existing === undefined) {
        merged[key] = value;
      } else if (
        typeof existing === 'object' &&
        existing !== null &&
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(existing) &&
        !Array.isArray(value)
      ) {
        // Deep merge plain objects one level
        merged[key] = { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) };
      } else {
        // Primitives / booleans: later value wins (true wins over false)
        merged[key] = value;
      }
    }
  }

  return merged as Partial<ServerCapabilities>;
}
