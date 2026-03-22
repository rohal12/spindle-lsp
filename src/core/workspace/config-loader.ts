import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Spindle project config as loaded from `spindle.config.yaml/yml/json`.
 */
export interface SpindleProjectConfig {
  macros: Record<string, any>;
}

const CONFIG_FILENAMES = [
  'spindle.config.yaml',
  'spindle.config.yml',
  'spindle.config.json',
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
  return {
    macros: (typeof obj.macros === 'object' && obj.macros !== null)
      ? obj.macros as Record<string, any>
      : {},
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
