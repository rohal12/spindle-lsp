import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MacroInfo, ChildConstraint } from '../types.js';

/**
 * Supplement entry as found in macro-supplements.json or user config.
 * Uses `container` (boolean) which maps to `block` on MacroInfo.
 */
interface SupplementEntry {
  name?: string;
  description?: string;
  parameters?: string[];
  container?: boolean;
  children?: ChildConstraint[];
  parents?: string[];
  skipArgs?: boolean;
}

/** Shape of entries in @rohal12/spindle's macro-registry.json */
interface BuiltinMacroEntry {
  name: string;
  block: boolean;
  subMacros: string[];
  storeVar?: boolean;
  interpolate?: boolean;
  merged?: boolean;
  source: string;
}

/**
 * Registry of all known macros, merging data from three tiers:
 * 1. Builtins — from @rohal12/spindle/tooling getMacroRegistry()
 * 2. Supplements — macro-supplements.json (descriptions, parameters, children)
 * 3. User config — workspace-level overrides
 *
 * All lookups are case-insensitive.
 */
export class MacroRegistry {
  private macros = new Map<string, MacroInfo>();

  /**
   * Load built-in macro metadata from @rohal12/spindle's macro-registry.json.
   * This is the base layer that provides name, block, subMacros, flags, source.
   */
  /** Warnings collected during loadBuiltins for logging. */
  readonly warnings: string[] = [];

  loadBuiltins(): void {
    let builtinMacros: BuiltinMacroEntry[] = [];

    try {
      // Resolve macro-registry.json from @rohal12/spindle package.
      // Try createRequire first (works in bundled/global contexts),
      // fall back to directory walk.
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const registryPath = this.resolveRegistryPathViaRequire(thisDir)
        ?? this.resolveRegistryPath(thisDir);
      if (registryPath) {
        const raw = readFileSync(registryPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          this.warnings.push(
            `macro-registry.json: expected array, got ${typeof parsed}. Continuing with supplements only.`,
          );
        } else {
          builtinMacros = parsed;
        }
      }
    } catch (err: unknown) {
      // Package not available or malformed — log and continue with supplements only
      const message = err instanceof Error ? err.message : String(err);
      this.warnings.push(
        `Failed to load builtin macros: ${message}. Continuing with supplements only.`,
      );
    }

    for (const m of builtinMacros) {
      try {
        const key = m.name.toLowerCase();
        this.macros.set(key, {
          name: m.name,
          block: m.block,
          subMacros: m.subMacros ?? [],
          storeVar: m.storeVar,
          interpolate: m.interpolate,
          merged: m.merged,
          source: m.source === 'builtin' ? 'builtin' : 'user',
        });
      } catch {
        // Skip malformed entries
        this.warnings.push(`Skipped malformed builtin macro entry: ${JSON.stringify(m)}`);
      }
    }
  }

  /**
   * Overlay supplement data onto the registry.
   * Supplements provide descriptions, parameters, children, parents, skipArgs.
   * The `container` field maps to `block` on MacroInfo.
   */
  loadSupplements(supplements: Record<string, SupplementEntry>): void {
    this.mergeEntries(supplements);
  }

  /**
   * Overlay user config onto the registry.
   * Same format as supplements; applied last so it wins.
   */
  loadConfig(config: Record<string, SupplementEntry>): void {
    this.mergeEntries(config);
  }

  /** Add or replace a single macro entry. */
  addMacro(info: Partial<MacroInfo> & { name: string }): void {
    const key = info.name.toLowerCase();
    const existing = this.macros.get(key);
    this.macros.set(key, {
      name: info.name,
      block: info.block ?? existing?.block ?? false,
      subMacros: info.subMacros ?? existing?.subMacros ?? [],
      source: info.source ?? existing?.source ?? 'user',
      storeVar: info.storeVar ?? existing?.storeVar,
      interpolate: info.interpolate ?? existing?.interpolate,
      merged: info.merged ?? existing?.merged,
      description: info.description ?? existing?.description,
      parameters: info.parameters ?? existing?.parameters,
      children: info.children ?? existing?.children,
      parents: info.parents ?? existing?.parents,
      skipArgs: info.skipArgs ?? existing?.skipArgs,
    });
  }

  /** Get a macro by name (case-insensitive). */
  getMacro(name: string): MacroInfo | undefined {
    return this.macros.get(name.toLowerCase());
  }

  /** Check if a macro is a block (container) macro. */
  isBlock(name: string): boolean {
    return this.macros.get(name.toLowerCase())?.block ?? false;
  }

  /** Check if a macro is a sub-macro (has parents). */
  isSubMacro(name: string): boolean {
    const info = this.macros.get(name.toLowerCase());
    return (info?.parents != null && info.parents.length > 0);
  }

  /** Get all registered macros. */
  getAllMacros(): MacroInfo[] {
    return Array.from(this.macros.values());
  }

  /**
   * Walk up directory tree from `startDir` to find the
   * @rohal12/spindle/dist/pkg/macro-registry.json file.
   */
  /**
   * Resolve macro-registry.json using Node's require resolution.
   * Works in bundled contexts where import.meta.url may not be near node_modules.
   */
  private resolveRegistryPathViaRequire(startDir: string): string | null {
    try {
      const require = createRequire(join(startDir, '_'));
      // Resolve the tooling entry point, then navigate to the sibling JSON
      const toolingPath = require.resolve('@rohal12/spindle/tooling');
      const candidate = join(dirname(toolingPath), 'macro-registry.json');
      if (existsSync(candidate)) return candidate;
    } catch {
      // Package not resolvable via require — fall through
    }
    return null;
  }

  private resolveRegistryPath(startDir: string): string | null {
    const target = join('node_modules', '@rohal12', 'spindle', 'dist', 'pkg', 'macro-registry.json');
    let dir = startDir;
    const { root } = parsePath(dir);
    while (dir !== root) {
      const candidate = join(dir, target);
      if (existsSync(candidate)) {
        return candidate;
      }
      dir = dirname(dir);
    }
    return null;
  }

  /** Merge a set of supplement/config entries into the registry. */
  private mergeEntries(entries: Record<string, SupplementEntry>): void {
    for (const [rawKey, entry] of Object.entries(entries)) {
      const key = rawKey.toLowerCase();
      const existing = this.macros.get(key);

      if (existing) {
        // Overlay fields — supplement fields win when present
        if (entry.description !== undefined) existing.description = entry.description;
        if (entry.parameters !== undefined) existing.parameters = entry.parameters;
        if (entry.children !== undefined) existing.children = entry.children;
        if (entry.parents !== undefined) existing.parents = entry.parents;
        if (entry.skipArgs !== undefined) existing.skipArgs = entry.skipArgs;
        if (entry.container !== undefined) existing.block = entry.container;
      } else {
        // Create a new entry from the supplement
        this.macros.set(key, {
          name: entry.name ?? rawKey,
          block: entry.container ?? false,
          subMacros: [],
          source: 'user',
          description: entry.description,
          parameters: entry.parameters,
          children: entry.children,
          parents: entry.parents,
          skipArgs: entry.skipArgs,
        });
      }
    }
  }
}
