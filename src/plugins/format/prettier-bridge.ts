import type { PrettierLike } from '@rohal12/spindle/tooling';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';
import { parse as parseYaml } from 'yaml';

type Prettier = typeof import('prettier');

let prettier: Promise<Prettier | null> | undefined;

/** Prettier and the options it is given for a document's code, styles and HTML. */
export interface PrettierSetup {
  prettier: PrettierLike;
  options: object;
}

/**
 * The project's Prettier (an optional dependency) and its configuration,
 * resolved for the document (or a file in the working directory) over
 * `{ tabWidth: 2 }`. Executable configs, shared config imports and plugins
 * require SPINDLE_LSP_TRUSTED_FORMAT=1 in the host environment. Undefined when
 * Prettier is not installed: the code in passages then stays as written.
 */
export async function loadPrettier(filePath?: string): Promise<PrettierSetup | undefined> {
  prettier ??= import('prettier').catch(() => null);
  const p = await prettier;
  if (!p) return undefined;
  let resolved: object | null = null;
  try {
    const path = filePath?.startsWith('file:') ? fileURLToPath(filePath) : filePath;
    const target = path ?? resolve(process.cwd(), 'story.tw');
    resolved = process.env.SPINDLE_LSP_TRUSTED_FORMAT === '1'
      ? await p.resolveConfig(target, { useCache: false })
      : await loadDataConfig(p, target);
  } catch {
    // An unreadable/invalid config leaves the bundled formatter's defaults.
  }
  // Spindle and the Twee layer format LF text. Restore the document's EOL
  // once, in formatDocument; Prettier must not introduce CR or CRLF here.
  return { prettier: p, options: { tabWidth: 2, ...resolved, endOfLine: 'lf' } };
}

/** Discover with Prettier, but never invoke its executable config loaders. */
async function loadDataConfig(p: Prettier, target: string): Promise<object | null> {
  const configFile = await p.resolveConfigFile(target);
  if (!configFile || !['', '.json', '.yaml', '.yml'].includes(extname(configFile))) return null;
  const source = await readFile(configFile, 'utf8');
  let config = extname(configFile) === '.json' ? JSON.parse(source) : parseYaml(source);
  if (['package.json', 'package.yaml'].includes(basename(configFile))) config = config?.prettier;
  // A string is a shareable config module, even in JSON or YAML.
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const { overrides, ...base } = config;
  let options = base;
  const file = relative(dirname(configFile), resolve(target)).replaceAll('\\', '/');
  for (const override of Array.isArray(overrides) ? overrides : []) {
    if (matchesPatterns(file, override.files, override.excludeFiles)) {
      options = { ...options, ...override.options };
    }
  }
  // Plugins execute host code regardless of whether their config is data.
  const { plugins: _plugins, $schema: _schema, ...safe } = options;
  return safe;
}

function matchesPatterns(file: string, patterns: unknown, excludedPatterns: unknown): boolean {
  const excluded = Array.isArray(excludedPatterns) ? excludedPatterns : [excludedPatterns];
  return (Array.isArray(patterns) ? patterns : [patterns]).some(pattern => {
    if (typeof pattern !== 'string') return false;
    // Prettier applies exclusions with the matching file pattern's basename mode.
    const options = { matchBase: !pattern.includes('/'), dot: true };
    return minimatch(file, pattern, options)
      && !excluded.some(exclude => typeof exclude === 'string' && minimatch(file, exclude, options));
  });
}
