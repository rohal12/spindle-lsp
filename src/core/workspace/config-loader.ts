import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Spindle project config as loaded from config files.
 */
export interface SpindleProjectConfig {
  macros: Record<string, any>;
  enums?: Record<string, string>;
}

/**
 * Config files searched in order of priority.
 * Supports both the new `spindle.config.*` format and the legacy
 * `t3lt.twee-config.*` format (used by twee3-language-tools).
 */
const CONFIG_FILENAMES = [
  'spindle.config.yaml',
  'spindle.config.yml',
  'spindle.config.json',
  't3lt.twee-config.yaml',
  't3lt.twee-config.yml',
  't3lt.twee-config.json',
];

const EMPTY_CONFIG: SpindleProjectConfig = { macros: {} };

/**
 * Parse a config file's content in the given format.
 * Returns a SpindleProjectConfig with at least an empty `macros` record.
 */
export function parseConfig(
  content: string,
  format: 'yaml' | 'json',
): SpindleProjectConfig {
  if (!content.trim()) {
    return { macros: {} };
  }

  let raw: unknown;
  if (format === 'json') {
    raw = JSON.parse(content);
  } else {
    raw = parseYaml(content);
  }

  if (typeof raw !== 'object' || raw === null) {
    return { macros: {} };
  }

  const obj = raw as Record<string, unknown>;

  // Support legacy t3lt.twee-config format: { "spindle-0": { macros: {...}, enums: {...} } }
  const spindle0 = obj['spindle-0'] as Record<string, unknown> | undefined;
  const source = (spindle0 && typeof spindle0 === 'object') ? spindle0 : obj;

  return {
    macros: (typeof source.macros === 'object' && source.macros !== null)
      ? source.macros as Record<string, any>
      : {},
    enums: (typeof source.enums === 'object' && source.enums !== null)
      ? source.enums as Record<string, string>
      : undefined,
  };
}

/**
 * Search for a config file in the workspace root directory.
 * Checks for spindle.config.yaml, spindle.config.yml, and spindle.config.json
 * in that order. Returns the full path of the first match, or null.
 */
export function findConfigFile(workspaceRoot: string): string | null {
  for (const name of CONFIG_FILENAMES) {
    const fullPath = join(workspaceRoot, name);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

/**
 * Load and parse the project config from the workspace root.
 * Returns a default empty config if no config file is found.
 */
export function loadConfigFromDisk(workspaceRoot: string): SpindleProjectConfig {
  const configPath = findConfigFile(workspaceRoot);
  if (!configPath) {
    return { ...EMPTY_CONFIG };
  }

  const content = readFileSync(configPath, 'utf-8');
  const format = configPath.endsWith('.json') ? 'json' : 'yaml';
  return parseConfig(content, format);
}
