import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MacroRegistry, findRegistryPath } from '../../src/core/workspace/macro-registry.js';

describe('MacroRegistry builtin resolution', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A project whose installed Spindle ships a registry with one macro. */
  function projectWithSpindle(macro: string): string {
    const root = mkdtempSync(join(tmpdir(), 'spindle-lsp-registry-'));
    dirs.push(root);
    const pkg = join(root, 'node_modules', '@rohal12', 'spindle', 'dist', 'pkg');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, 'macro-registry.json'),
      JSON.stringify([{ name: macro, block: false, subMacros: [], source: 'builtin' }]),
    );
    mkdirSync(join(root, 'src', 'story'), { recursive: true });
    return root;
  }

  it('reads the registry of the Spindle installed in the workspace', () => {
    const root = projectWithSpindle('projectonly');
    const registry = new MacroRegistry();
    registry.loadBuiltins(join(root, 'src', 'story'));

    expect(registry.builtinsPath).toBe(findRegistryPath(root));
    expect(registry.getMacro('projectonly')?.source).toBe('builtin');
    // The project's registry replaces, not extends, the fallback copy.
    expect(registry.getMacro('if')).toBeUndefined();
  });

  it("falls back to the LSP's own copy when the workspace has none", () => {
    const root = mkdtempSync(join(tmpdir(), 'spindle-lsp-registry-'));
    dirs.push(root);
    const registry = new MacroRegistry();
    registry.loadBuiltins(root);

    expect(registry.builtinsPath).not.toBeNull();
    expect(registry.getMacro('if')?.block).toBe(true);
  });
});

describe('MacroRegistry', () => {
  it('loads builtins from @rohal12/spindle/tooling', () => {
    const registry = new MacroRegistry();
    registry.loadBuiltins();
    // Should have all built-in macros (if, set, for, etc.)
    const ifMacro = registry.getMacro('if');
    expect(ifMacro).toBeDefined();
    expect(ifMacro!.name).toBe('if');
    expect(ifMacro!.block).toBe(true);
    expect(ifMacro!.source).toBe('builtin');
  });

  it('merges supplements onto builtins', () => {
    const registry = new MacroRegistry();
    registry.loadBuiltins();
    registry.loadSupplements({
      if: {
        description: 'Conditional block',
        parameters: ['...text'],
        container: true,
        children: [{ name: 'else', max: 1 }, { name: 'elseif' }],
      },
    });

    const ifMacro = registry.getMacro('if');
    expect(ifMacro).toBeDefined();
    expect(ifMacro!.description).toBe('Conditional block');
    expect(ifMacro!.parameters).toEqual(['...text']);
    expect(ifMacro!.children).toEqual([
      { name: 'else', max: 1 },
      { name: 'elseif' },
    ]);
    // block should come from builtin (true), container in supplement confirms
    expect(ifMacro!.block).toBe(true);
  });

  it('maps container to block in supplements', () => {
    const registry = new MacroRegistry();
    // Start with no builtins — add via supplement
    registry.loadSupplements({
      custom: {
        name: 'custom',
        description: 'A custom block macro',
        container: true,
      },
    });

    const custom = registry.getMacro('custom');
    expect(custom).toBeDefined();
    expect(custom!.block).toBe(true);
  });

  it('performs case-insensitive lookup', () => {
    const registry = new MacroRegistry();
    registry.addMacro({ name: 'TestMacro', block: false, source: 'user', subMacros: [] });
    expect(registry.getMacro('testmacro')).toBeDefined();
    expect(registry.getMacro('TESTMACRO')).toBeDefined();
    expect(registry.getMacro('TestMacro')).toBeDefined();
  });

  it('isBlock returns correct value', () => {
    const registry = new MacroRegistry();
    registry.loadBuiltins();
    expect(registry.isBlock('if')).toBe(true);
    expect(registry.isBlock('set')).toBe(false);
    expect(registry.isBlock('unknown')).toBe(false);
  });

  it('isSubMacro returns correct value', () => {
    const registry = new MacroRegistry();
    registry.loadBuiltins();
    registry.loadSupplements({
      elseif: { name: 'elseif', parents: ['if'] },
      else: { name: 'else', parents: ['if'] },
    });
    expect(registry.isSubMacro('elseif')).toBe(true);
    expect(registry.isSubMacro('else')).toBe(true);
    expect(registry.isSubMacro('if')).toBe(false);
    expect(registry.isSubMacro('set')).toBe(false);
  });

  it('addMacro adds a user-defined macro', () => {
    const registry = new MacroRegistry();
    registry.addMacro({
      name: 'MyWidget',
      block: true,
      source: 'user',
      subMacros: [],
    });
    const macro = registry.getMacro('mywidget');
    expect(macro).toBeDefined();
    expect(macro!.name).toBe('MyWidget');
    expect(macro!.block).toBe(true);
    expect(macro!.source).toBe('user');
  });

  it('getAllMacros returns all registered macros', () => {
    const registry = new MacroRegistry();
    registry.loadBuiltins();
    const all = registry.getAllMacros();
    expect(all.length).toBeGreaterThan(0);
    // Should include well-known macros
    const names = all.map(m => m.name.toLowerCase());
    expect(names).toContain('if');
    expect(names).toContain('set');
    expect(names).toContain('for');
  });

  it('loadConfig overlays on top of builtins + supplements', () => {
    const registry = new MacroRegistry();
    registry.loadBuiltins();
    registry.loadSupplements({
      set: { description: 'Supplement description', parameters: ['...text'] },
    });
    registry.loadConfig({
      set: { description: 'User config description' },
    });

    const macro = registry.getMacro('set');
    expect(macro).toBeDefined();
    expect(macro!.description).toBe('User config description');
    // parameters from supplement should persist
    expect(macro!.parameters).toEqual(['...text']);
  });

  it('loadConfig replaces the previous config, reverting removed entries', () => {
    const registry = new MacroRegistry();
    registry.loadBuiltins();
    registry.loadSupplements({
      set: { description: 'Supplement description', parameters: ['...text'] },
    });
    registry.loadConfig({
      set: { description: 'User config description', parameters: [] },
      newmacro: { parameters: [] },
    });
    expect(registry.getMacro('newmacro')).toBeDefined();
    expect(registry.getMacro('set')!.description).toBe('User config description');

    // Reload with newmacro removed and set no longer overridden
    registry.loadConfig({ other: { container: true } });
    expect(registry.getMacro('newmacro')).toBeUndefined();
    expect(registry.getMacro('set')!.description).toBe('Supplement description');
    expect(registry.getMacro('set')!.parameters).toEqual(['...text']);
    expect(registry.isBlock('other')).toBe(true);

    // Empty config removes everything the config contributed
    registry.loadConfig({});
    expect(registry.getMacro('other')).toBeUndefined();
    expect(registry.getMacro('set')!.source).toBe('builtin');
  });

  it('reloading config keeps discovered macros and drops removed config overrides', () => {
    const registry = new MacroRegistry();
    registry.loadBuiltins();
    registry.setDiscoveredMacros([{ name: 'hello', block: true, description: 'Discovered' }]);
    registry.loadConfig({ hello: { container: false, description: 'Configured' } });
    expect(registry.isBlock('hello')).toBe(false);
    expect(registry.getMacro('hello')!.description).toBe('Configured');

    // Removing the override falls back to the discovered definition
    registry.loadConfig({});
    expect(registry.isBlock('hello')).toBe(true);
    expect(registry.getMacro('hello')!.description).toBe('Discovered');
  });

  it('supplement skipArgs is preserved', () => {
    const registry = new MacroRegistry();
    registry.loadBuiltins();
    registry.loadSupplements({
      for: { skipArgs: true },
    });
    const forMacro = registry.getMacro('for');
    expect(forMacro).toBeDefined();
    expect(forMacro!.skipArgs).toBe(true);
  });
});
