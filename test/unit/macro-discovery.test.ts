import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { discoverMacrosFromSource, discoverMacrosFromStoryInit } from '../../src/core/parsing/macro-discovery.js';
import { MacroRegistry } from '../../src/core/workspace/macro-registry.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

describe('discoverMacrosFromSource', () => {
  it('extracts macros from TS source', () => {
    const source = readFileSync(resolve(__dirname, '../fixtures/custom-macros.ts'), 'utf-8');
    const macros = discoverMacrosFromSource(source);
    expect(macros).toHaveLength(2);
    expect(macros[0].name).toBe('agebox');
    expect(macros[0].storeVar).toBe(true);
    expect(macros[0].description).toBe('Age selection box');
    expect(macros[1].name).toBe('chargenOption');
    expect(macros[1].merged).toBe(true);
    expect(macros[1].block).toBe(true);
    expect(macros[1].subMacros).toEqual(['option']);
  });

  it('returns empty for source without defineMacro', () => {
    expect(discoverMacrosFromSource('const x = 1;')).toHaveLength(0);
  });

  it('handles malformed config gracefully', () => {
    const source = 'Story.defineMacro({ name: computed() });';
    expect(() => discoverMacrosFromSource(source)).not.toThrow();
  });
});

describe('discoverMacrosFromStoryInit', () => {
  it('extracts from StoryInit passage content', () => {
    const content = `{do}
Story.defineMacro({
  name: 'custom',
  block: true,
  render: () => null,
});
{/do}`;
    const macros = discoverMacrosFromStoryInit(content);
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('custom');
    expect(macros[0].block).toBe(true);
  });
});

describe('MacroRegistry discovered macros', () => {
  it('adds discovered macros and infers block from subMacros like Story.defineMacro', () => {
    const registry = new MacroRegistry();
    registry.setDiscoveredMacros([
      { name: 'dialog', subMacros: ['say'], description: 'A dialog' },
      { name: 'plain', subMacros: ['x'], block: false },
    ]);

    expect(registry.getMacro('dialog')).toMatchObject({
      name: 'dialog', block: true, subMacros: ['say'], source: 'user', description: 'A dialog',
    });
    expect(registry.getMacro('plain')?.block).toBe(false);
    // Sub-macros become known macros restricted to their parent
    expect(registry.getMacro('say')).toMatchObject({ block: false, parents: ['dialog'] });
    expect(registry.getAllMacros().map(m => m.name)).toEqual(expect.arrayContaining(['dialog', 'say']));
  });

  it('replaces previously discovered macros and restores built-ins', () => {
    const registry = new MacroRegistry();
    registry.loadBuiltins();
    expect(registry.isBlock('set')).toBe(false);

    registry.setDiscoveredMacros([{ name: 'set', block: true }, { name: 'hello' }]);
    expect(registry.isBlock('set')).toBe(true);
    expect(registry.getMacro('hello')).toBeDefined();

    registry.setDiscoveredMacros([]);
    expect(registry.isBlock('set')).toBe(false);
    expect(registry.getMacro('set')?.source).toBe('builtin');
    expect(registry.getMacro('hello')).toBeUndefined();
  });

  it('lets user config win over discovered metadata regardless of load order', () => {
    for (const configFirst of [true, false]) {
      const registry = new MacroRegistry();
      registry.loadBuiltins();
      const loadConfig = () => registry.loadConfig({
        hello: { description: 'From config', container: false },
      });
      if (configFirst) loadConfig();
      registry.setDiscoveredMacros([{ name: 'hello', block: true, storeVar: true, description: 'Discovered' }]);
      if (!configFirst) loadConfig();

      const hello = registry.getMacro('hello');
      expect(hello?.description).toBe('From config');
      expect(hello?.block).toBe(false);
      // Fields the config does not set still come from discovery
      expect(hello?.storeVar).toBe(true);
    }
  });
});

describe('WorkspaceModel macro discovery', () => {
  const storyInit = (name: string) => `:: StoryInit
{do}
Story.defineMacro({name: "${name}", render: () => "${name}"});
{/do}

:: Start
{hello}
`;

  const sp100 = (ws: WorkspaceModel, uri: string) =>
    computeDiagnostics(uri, ws).filter(d => d.code === 'SP100').map(d => d.message);

  it('registers macros defined in StoryInit during initialize', () => {
    const ws = new WorkspaceModel();
    ws.initialize(new Map([['file:///story.tw', storyInit('hello')]]));

    expect(ws.macros.getMacro('hello')).toMatchObject({ name: 'hello', source: 'user' });
    expect(sp100(ws, 'file:///story.tw')).toEqual([]);
    ws.dispose();
  });

  it('registers macros defined in script passages with their capabilities', () => {
    const ws = new WorkspaceModel();
    ws.initialize(new Map([['file:///story.tw', `:: Macros [script]
Story.defineMacro({
  name: 'panel',
  subMacros: ['tab'],
  render: (props, ctx) => null,
});

:: Start
{panel}{tab}{/panel}
`]]));

    expect(ws.macros.getMacro('panel')?.block).toBe(true);
    const codes = computeDiagnostics('file:///story.tw', ws).map(d => d.code);
    expect(codes).not.toContain('SP100');
    expect(codes).not.toContain('SP104');
    expect(codes).not.toContain('SP107');
    ws.dispose();
  });

  it('registers macros defined in JavaScript documents', () => {
    const ws = new WorkspaceModel();
    ws.initialize(new Map([['file:///story.tw', ':: Start\n{fromjs}\n']]));
    expect(sp100(ws, 'file:///story.tw')).toEqual(['Unrecognized macro: {fromjs}']);

    ws.documents.open('file:///macros.js', 'Story.defineMacro({ name: "fromjs", render() { return null; } });');
    expect(sp100(ws, 'file:///story.tw')).toEqual([]);

    ws.documents.close('file:///macros.js');
    expect(sp100(ws, 'file:///story.tw')).toEqual(['Unrecognized macro: {fromjs}']);
    ws.dispose();
  });

  it('removes stale discovered macros when the source changes', () => {
    const ws = new WorkspaceModel();
    ws.initialize(new Map([['file:///story.tw', storyInit('hello')]]));
    expect(sp100(ws, 'file:///story.tw')).toEqual([]);

    ws.documents.update('file:///story.tw', storyInit('goodbye'));
    expect(ws.macros.getMacro('hello')).toBeUndefined();
    expect(ws.macros.getMacro('goodbye')).toBeDefined();
    expect(sp100(ws, 'file:///story.tw')).toEqual(['Unrecognized macro: {hello}']);

    ws.documents.update('file:///story.tw', storyInit('hello'));
    expect(sp100(ws, 'file:///story.tw')).toEqual([]);
    ws.dispose();
  });

  it('removes discovered macros when the defining document closes', () => {
    const ws = new WorkspaceModel();
    ws.initialize(new Map([
      ['file:///init.tw', ':: StoryInit\n{do}Story.defineMacro({name: "hello", render: () => null});{/do}\n'],
      ['file:///start.tw', ':: Start\n{hello}\n'],
    ]));
    expect(sp100(ws, 'file:///start.tw')).toEqual([]);

    ws.documents.close('file:///init.tw');
    expect(sp100(ws, 'file:///start.tw')).toEqual(['Unrecognized macro: {hello}']);
    ws.dispose();
  });

  it('ignores Story.defineMacro outside StoryInit {do} blocks and script passages', () => {
    const ws = new WorkspaceModel();
    ws.initialize(new Map([['file:///story.tw', `:: Other
{do}Story.defineMacro({name: "hello", render: () => null});{/do}

:: Start
{hello}
`]]));
    expect(ws.macros.getMacro('hello')).toBeUndefined();
    ws.dispose();
  });
});
