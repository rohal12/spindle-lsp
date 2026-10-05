import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MacroInfo, ChildConstraint } from '../types.js';
import type { DiscoveredMacro } from '../parsing/macro-discovery.js';

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
 * Registry of all known macros, merging data from four tiers
 * (later tiers win for the fields they set):
 * 1. Builtins — from @rohal12/spindle/tooling getMacroRegistry()
 * 2. Supplements — macro-supplements.json (descriptions, parameters, children)
 * 3. Discovered — Story.defineMacro() calls found in the workspace
 *    (see setDiscoveredMacros). At runtime these replace a built-in of the
 *    same name, so they win over tiers 1–2.
 * 4. User config — workspace-level overrides (loadConfig); explicit
 *    configuration always wins over discovered metadata.
 *
 * Discovered macros are kept in a separate layer and composed on lookup,
 * so they can be replaced wholesale whenever the workspace changes without
 * disturbing the other tiers.
 *
 * All lookups are case-insensitive.
 */
export class MacroRegistry {
  private macros = new Map<string, MacroInfo>();

  /** Tier 3: macros discovered from Story.defineMacro() calls, keyed by lowercase name. */
  private discovered = new Map<string, Partial<MacroInfo> & { name: string }>();

  /** Tier 4: user config entries, kept so they can be re-applied over discovered macros. */
  private configEntries = new Map<string, SupplementEntry>();

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
    for (const [rawKey, entry] of Object.entries(config)) {
      const key = rawKey.toLowerCase();
      this.configEntries.set(key, { ...this.configEntries.get(key), ...entry });
    }
    this.mergeEntries(config);
  }

  /**
   * Replace the set of macros discovered from Story.defineMacro() calls.
   * Previously discovered definitions that are no longer present are dropped,
   * restoring whatever the other tiers define for that name.
   *
   * Mirrors Story.defineMacro(): a macro is a block when `block: true`, or
   * when it declares sub-macros and does not set `block: false`. Each
   * sub-macro becomes a known macro that may only appear inside its parent.
   */
  setDiscoveredMacros(macros: DiscoveredMacro[]): void {
    this.discovered.clear();

    for (const m of macros) {
      const subMacros = m.subMacros ?? [];
      this.discovered.set(m.name.toLowerCase(), {
        name: m.name,
        block: m.block === true || (m.block !== false && subMacros.length > 0),
        subMacros,
        storeVar: m.storeVar,
        interpolate: m.interpolate,
        merged: m.merged,
        description: m.description,
        source: 'user',
      });
    }

    for (const m of macros) {
      for (const sub of m.subMacros ?? []) {
        const key = sub.toLowerCase();
        const existing = this.discovered.get(key);
        if (existing) {
          existing.parents = [...(existing.parents ?? []), m.name];
        } else {
          this.discovered.set(key, { name: sub, block: false, subMacros: [], source: 'user', parents: [m.name] });
        }
      }
    }
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
    return this.resolve(name.toLowerCase());
  }

  /** Check if a macro is a block (container) macro. */
  isBlock(name: string): boolean {
    return this.getMacro(name)?.block ?? false;
  }

  /** Check if a macro is a sub-macro (has parents). */
  isSubMacro(name: string): boolean {
    const info = this.getMacro(name);
    return (info?.parents != null && info.parents.length > 0);
  }

  /** Get all registered macros. */
  getAllMacros(): MacroInfo[] {
    const keys = new Set([...this.macros.keys(), ...this.discovered.keys()]);
    return Array.from(keys, key => this.resolve(key)!);
  }

  /**
   * Compose the effective entry for a lowercase key: builtins/supplements/
   * config (stored in `macros`), overlaid by discovered metadata, with user
   * config re-applied on top so it keeps precedence.
   */
  private resolve(key: string): MacroInfo | undefined {
    const base = this.macros.get(key);
    const found = this.discovered.get(key);
    if (!found) return base;

    const info: MacroInfo = {
      ...base,
      name: base?.name ?? found.name,
      block: found.block ?? base?.block ?? false,
      subMacros: found.subMacros?.length ? found.subMacros : base?.subMacros ?? [],
      source: 'user',
      storeVar: found.storeVar ?? base?.storeVar,
      interpolate: found.interpolate ?? base?.interpolate,
      merged: found.merged ?? base?.merged,
      description: found.description ?? base?.description,
      // A discovered sub-macro may also belong to other (e.g. built-in) parents
      parents: found.parents
        ? [...new Set([...(base?.parents ?? []), ...found.parents])]
        : base?.parents,
    };

    const config = this.configEntries.get(key);
    if (config) {
      if (config.description !== undefined) info.description = config.description;
      if (config.parameters !== undefined) info.parameters = config.parameters;
      if (config.children !== undefined) info.children = config.children;
      if (config.parents !== undefined) info.parents = config.parents;
      if (config.skipArgs !== undefined) info.skipArgs = config.skipArgs;
      if (config.container !== undefined) info.block = config.container;
    }

    return info;
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
