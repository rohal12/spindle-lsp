import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MacroInfo, ChildConstraint, ParameterDoc } from '../types.js';
import type { DiscoveredMacro } from '../parsing/macro-discovery.js';

/**
 * Supplement entry as found in macro-supplements.json or user config.
 * Uses `container` (boolean) which maps to `block` on MacroInfo.
 */
interface SupplementEntry {
  name?: string;
  description?: string;
  parameters?: string[];
  parameterDocs?: ParameterDoc[];
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
 * 1. Builtins — @rohal12/spindle's macro-registry.json (the project's copy)
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

  /** Entries as they were before the current user config was applied (undefined = absent). */
  private configSnapshot = new Map<string, MacroInfo | undefined>();

  /** Tier 3: macros discovered from Story.defineMacro() calls, keyed by lowercase name. */
  private discovered = new Map<string, Partial<MacroInfo> & { name: string }>();

  /** Tier 4: user config entries, kept so they can be re-applied over discovered macros. */
  private configEntries = new Map<string, SupplementEntry>();

  /** Warnings collected during loadBuiltins for logging. */
  readonly warnings: string[] = [];

  /** Path of the macro-registry.json the builtins were loaded from, if any. */
  builtinsPath: string | null = null;

  /**
   * Load built-in macro metadata from @rohal12/spindle's macro-registry.json.
   * This is the base layer that provides name, block, subMacros, flags, source.
   *
   * The project's own Spindle is authoritative: the registry is resolved from
   * `workspaceRoot` first, and from this package's install location (a
   * development copy, or one installed for the peer dependency) only when the
   * workspace has none.
   */
  loadBuiltins(workspaceRoot?: string): void {
    let builtinMacros: BuiltinMacroEntry[] = [];

    try {
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const registryPath = (workspaceRoot ? findRegistryPath(workspaceRoot) : null)
        ?? findRegistryPath(thisDir);
      if (!registryPath) {
        this.warnings.push(
          'macro-registry.json not found: install @rohal12/spindle in the project. Continuing with supplements only.',
        );
      } else {
        this.builtinsPath = registryPath;
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
      // Malformed or unreadable registry — log and continue with supplements only
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
   *
   * Replaces any previously loaded config: entries from the last call are
   * reverted first, so macros removed from the config disappear (or fall
   * back to their builtin/supplement definition).
   */
  loadConfig(config: Record<string, SupplementEntry>): void {
    for (const [key, previous] of this.configSnapshot) {
      if (previous) {
        this.macros.set(key, previous);
      } else {
        this.macros.delete(key);
      }
    }
    this.configSnapshot.clear();
    this.configEntries.clear();

    for (const rawKey of Object.keys(config)) {
      const key = rawKey.toLowerCase();
      if (!this.configSnapshot.has(key)) {
        const existing = this.macros.get(key);
        this.configSnapshot.set(key, existing ? { ...existing } : undefined);
      }
      this.configEntries.set(key, { ...this.configEntries.get(key), ...config[rawKey] });
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
      parameterDocs: info.parameterDocs ?? existing?.parameterDocs,
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
      if (config.parameterDocs !== undefined) info.parameterDocs = config.parameterDocs;
      if (config.children !== undefined) info.children = config.children;
      if (config.parents !== undefined) info.parents = config.parents;
      if (config.skipArgs !== undefined) info.skipArgs = config.skipArgs;
      if (config.container !== undefined) info.block = config.container;
    }

    return info;
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
        if (entry.parameterDocs !== undefined) existing.parameterDocs = entry.parameterDocs;
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
          parameterDocs: entry.parameterDocs,
          children: entry.children,
          parents: entry.parents,
          skipArgs: entry.skipArgs,
        });
      }
    }
  }
}

/**
 * Find @rohal12/spindle's macro-registry.json the way Node resolves a package:
 * check `node_modules` in `startDir` and each of its ancestors. (The file is
 * not an export of the package, and its `./tooling` export is import-only, so
 * `require.resolve` cannot locate it.)
 */
export function findRegistryPath(startDir: string): string | null {
  const target = join('node_modules', '@rohal12', 'spindle', 'dist', 'pkg', 'macro-registry.json');
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, target);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
