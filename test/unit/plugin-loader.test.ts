import { describe, it, expect } from 'vitest';
import { loadPlugins, mergeCapabilities } from '../../src/core/plugin/plugin-loader.js';
import type { SpindlePlugin, SpindleConfig, PluginContext } from '../../src/core/plugin/plugin-api.js';

function makePlugin(id: string, capabilities: Record<string, unknown> = {}): SpindlePlugin {
  return {
    id,
    capabilities,
    initialize(_ctx: PluginContext) {},
  };
}

describe('loadPlugins', () => {
  it('returns all plugins when no disabled list', () => {
    const plugins = [makePlugin('a'), makePlugin('b'), makePlugin('c')];
    const config: SpindleConfig = {};
    const result = loadPlugins(plugins, config);
    expect(result).toHaveLength(3);
    expect(result.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('filters disabled plugins by id', () => {
    const plugins = [makePlugin('a'), makePlugin('b'), makePlugin('c')];
    const config: SpindleConfig = { disabledPlugins: ['b'] };
    const result = loadPlugins(plugins, config);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('filters multiple disabled plugins', () => {
    const plugins = [makePlugin('a'), makePlugin('b'), makePlugin('c')];
    const config: SpindleConfig = { disabledPlugins: ['a', 'c'] };
    const result = loadPlugins(plugins, config);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  it('returns empty array for empty input', () => {
    const config: SpindleConfig = {};
    const result = loadPlugins([], config);
    expect(result).toEqual([]);
  });

  it('handles disabled list with IDs not in plugins', () => {
    const plugins = [makePlugin('a')];
    const config: SpindleConfig = { disabledPlugins: ['x', 'y'] };
    const result = loadPlugins(plugins, config);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });
});

describe('mergeCapabilities', () => {
  it('merges capabilities from multiple plugins', () => {
    const plugins = [
      makePlugin('diag', { diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } }),
      makePlugin('hover', { hoverProvider: true }),
      makePlugin('complete', { completionProvider: { triggerCharacters: ['<'] } }),
    ];
    const result = mergeCapabilities(plugins);
    expect(result.diagnosticProvider).toEqual({ interFileDependencies: true, workspaceDiagnostics: false });
    expect(result.hoverProvider).toBe(true);
    expect(result.completionProvider).toEqual({ triggerCharacters: ['<'] });
  });

  it('deep-merges object capabilities', () => {
    const plugins = [
      makePlugin('a', { completionProvider: { triggerCharacters: ['<'] } }),
      makePlugin('b', { completionProvider: { resolveProvider: true } }),
    ];
    const result = mergeCapabilities(plugins);
    expect(result.completionProvider).toEqual({
      triggerCharacters: ['<'],
      resolveProvider: true,
    });
  });

  it('later boolean values override earlier ones', () => {
    const plugins = [
      makePlugin('a', { hoverProvider: false }),
      makePlugin('b', { hoverProvider: true }),
    ];
    const result = mergeCapabilities(plugins);
    expect(result.hoverProvider).toBe(true);
  });

  it('returns empty for no plugins', () => {
    const result = mergeCapabilities([]);
    expect(result).toEqual({});
  });

  it('handles single plugin', () => {
    const plugins = [makePlugin('only', { hoverProvider: true, definitionProvider: true })];
    const result = mergeCapabilities(plugins);
    expect(result.hoverProvider).toBe(true);
    expect(result.definitionProvider).toBe(true);
  });
});
