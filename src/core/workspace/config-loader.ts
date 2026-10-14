import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Spindle project config as loaded from config files.
 */
export interface SpindleProjectConfig {
  macros: Record<string, Record<string, any>>;
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
    macros: normalizeMacroEntries(source.macros),
    enums: (typeof source.enums === 'object' && source.enums !== null)
      ? source.enums as Record<string, string>
      : undefined,
  };
}

/** Null means no metadata. Reject invalid shapes before replacing any usable config. */
export function normalizeMacroEntries(raw: unknown): SpindleProjectConfig['macros'] {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new Error('macros must be a mapping of macro names to metadata');
  const entries: SpindleProjectConfig['macros'] = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === null) { entries[name] = {}; continue; }
    if (!isRecord(value)) throw new Error(`macros.${name} must be a metadata object or null`);
    const valid = (key: string, test: (v: unknown) => boolean) => {
      if (value[key] !== undefined && !test(value[key])) throw new Error(`Invalid macros.${name}.${key}`);
    };
    for (const key of ['name', 'description']) valid(key, v => typeof v === 'string');
    for (const key of ['container', 'skipArgs']) valid(key, v => typeof v === 'boolean');
    for (const key of ['parameters', 'parents']) valid(key, v => Array.isArray(v) && v.every(item => typeof item === 'string'));
    valid('parameterDocs', v => Array.isArray(v) && v.every(item => isRecord(item) && typeof item.name === 'string' && (item.documentation === undefined || typeof item.documentation === 'string')));
    valid('children', v => Array.isArray(v) && v.every(item => isRecord(item) && typeof item.name === 'string' && ['min', 'max'].every(key => item[key] === undefined || typeof item[key] === 'number')));
    entries[name] = value;
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** Find a project's config above the directory its matched files share. */
export function findConfigRoot(directory: string): string {
  let search = directory;
  for (let i = 0; i < 10; i++) {
    if (findConfigFile(search)) return search;
    const parent = resolve(search, '..');
    if (parent === search) break;
    search = parent;
  }
  return directory;
}

/**
 * Load and parse exactly the given config file (e.g. from `check --config`).
 * The format is inferred from the extension: `.json` is parsed as JSON,
 * anything else as YAML.
 *
 * Unlike {@link loadConfigFromDisk}, this does not fall back to an empty
 * config: it throws an Error naming the path if the file cannot be read or
 * parsed.
 */
export function loadConfigFile(configPath: string): SpindleProjectConfig {
  let content: string;
  try {
    content = readFileSync(configPath, 'utf-8');
  } catch (err: unknown) {
    const reason = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? 'file not found'
      : err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read config file '${configPath}': ${reason}`);
  }

  const format = configPath.toLowerCase().endsWith('.json') ? 'json' : 'yaml';
  try {
    return parseConfig(content, format);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid ${format.toUpperCase()} in config file '${configPath}': ${reason}`);
  }
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
