import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { discoverMacrosFromSource, discoverMacrosFromStoryInit } from '../../src/core/parsing/macro-discovery.js';
import { MacroRegistry } from '../../src/core/workspace/macro-registry.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { findPassageReferences, findWidgetReferences } from '../../src/plugins/references.js';

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

describe('discoverMacrosFromSource: parameters', () => {
  const source = `Story.defineMacro({
  name: "damage", // the macro
  description: 'Apply damage',
  parameters: [
    { name: "target", type: "variable", required: true, description: "The $variable" },
    { name: 'amount', type: 'expression', required: true },
    { name: 'label', type: 'text', holds: 'markup' },
    { name: 'mode', type: 'options', parameters: [{ name: 'fast', type: 'flag' }, { name: 'by', type: 'string' }] },
  ],
  merged: true,
  render: function (props, ctx) { return { name: 'not this one', block: true, parameters: [{ name: 'x', type: 'flag' }] }; },
});`;

  it('reads the typed parameters, options included', () => {
    const [macro] = discoverMacrosFromSource(source);
    expect(macro).toMatchObject({ name: 'damage', description: 'Apply damage', merged: true });
    expect(macro.block).toBeUndefined();
    expect(macro.parameters).toEqual([
      { name: 'target', type: 'variable', required: true, description: 'The $variable' },
      { name: 'amount', type: 'expression', required: true },
      { name: 'label', type: 'text', holds: 'markup' },
      { name: 'mode', type: 'options', parameters: [{ name: 'fast', type: 'flag' }, { name: 'by', type: 'string' }] },
    ]);
  });

  it('reads no parameters when the definition declares none or one that Spindle rejects', () => {
    expect(discoverMacrosFromSource('Story.defineMacro({ name: "a", render() {} });')[0].parameters).toBeUndefined();
    // No type, or one that is not in the table: Story.defineMacro() throws, so the macro has no parameters
    expect(discoverMacrosFromSource('Story.defineMacro({ name: "a", parameters: [{ name: "p" }], render() {} });')[0].parameters).toBeUndefined();
    expect(discoverMacrosFromSource('Story.defineMacro({ name: "a", parameters: [{ name: "p", type: "bogus" }], render() {} });')[0].parameters).toBeUndefined();
    expect(discoverMacrosFromSource('Story.defineMacro({ name: "a", parameters: params, render() {} });')[0].parameters).toBeUndefined();
  });

  it('declares an empty list of parameters', () => {
    expect(discoverMacrosFromSource('Story.defineMacro({ name: "a", parameters: [], render() {} });')[0].parameters).toEqual([]);
  });

  it('reads the fields of the config, not those of a nested object or a comment', () => {
    const [macro] = discoverMacrosFromSource(`Story.defineMacro({
  /* name: "wrong", block: true */
  render() { const o = { name: "inner", storeVar: true }; return o; },
  name: "outer",
  subMacros: ['a', "b"],
});`);
    expect(macro).toEqual({ name: 'outer', subMacros: ['a', 'b'] });
  });

  it('gives typed parameters to the registry and the tooling API', () => {
    const registry = new MacroRegistry();
    registry.loadBuiltins();
    registry.setDiscoveredMacros(discoverMacrosFromSource(source));
    expect(registry.getMacro('damage')?.parameterDefs?.map(p => p.type)).toEqual(['variable', 'expression', 'text', 'options']);
    expect(registry.toolingMacros().find(m => m.name === 'damage')?.parameters).toHaveLength(4);

    // A definition replaces the built-in of its name, parameters included
    registry.setDiscoveredMacros([{ name: 'set', render: undefined } as never]);
    expect(registry.getMacro('set')?.parameterDefs).toBeUndefined();
    registry.setDiscoveredMacros([]);
    expect(registry.getMacro('set')?.parameterDefs?.length).toBeGreaterThan(0);
  });

  it('carries storeVar to the tooling API', () => {
    const registry = new MacroRegistry();
    registry.loadBuiltins();
    registry.setDiscoveredMacros([{ name: 'agebox', storeVar: true }]);
    const byName = new Map(registry.toolingMacros().map(m => [m.name, m]));
    expect(byName.get('agebox')?.storeVar).toBe(true);
    expect(byName.get('textbox')?.storeVar).toBe(true);
    expect(byName.get('set')?.storeVar).toBeFalsy();
  });
});

describe('typed parameters make the code in a macro\'s arguments visible', () => {
  const files = new Map([['file:///story.tw', `:: StoryInit
{do}
Story.defineMacro({
  name: "damage",
  parameters: [
    { name: "target", type: "variable" },
    { name: "amount", type: "expression" },
  ],
  render() { return null; },
});
Story.defineMacro({ name: "say", parameters: [{ name: "line", type: "text" }], render() { return null; } });
Story.defineMacro({ name: "shout", render() { return null; } });
{/do}

:: StoryVariables
$hp = 10

:: Start
{damage $hp $str * 2}
{say $text}
{shout $undeclared}
`]]);

  it('records the variables of an expression parameter, not those of a text parameter', () => {
    const ws = new WorkspaceModel();
    ws.initialize(files);
    expect(ws.variables.getUsages('str').map(u => u.range.start.line)).toEqual([18]);
    expect(ws.variables.getUndeclared('file:///story.tw').map(u => u.name)).toEqual(['str', 'undeclared']);
    expect(ws.variables.getUsages('text')).toEqual([]);
    ws.dispose();
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

  it('reads the {do} bodies as the tokenizer does', () => {
    const define = (name: string) => `Story.defineMacro({ name: "${name}", render: () => null });`;
    const found = discoverMacrosFromStoryInit([
      `{DO}${define('upper')}{/DO}`,
      `<!-- {do}${define('commented')}{/do} -->`,
      `{print "{do}${define('instring')}{/do}"}`,
      `{do}\r\n${define('crlf')}\r\n{/do}`,
    ].join('\n'));
    expect(found.map(m => m.name)).toEqual(['upper', 'crlf']);
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
Story.defineMacro({ name: "${name}", render: () => "${name}"});
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
    expect(sp100(ws, 'file:///story.tw')).toEqual(['Unknown macro {fromjs}.']);

    ws.documents.open('file:///macros.js', 'Story.defineMacro({ name: "fromjs", render() { return null; } });');
    expect(sp100(ws, 'file:///story.tw')).toEqual([]);

    ws.documents.close('file:///macros.js');
    expect(sp100(ws, 'file:///story.tw')).toEqual(['Unknown macro {fromjs}.']);
    ws.dispose();
  });

  it('treats JS/TS documents as macro sources only, not story markup (#47)', () => {
    const ws = new WorkspaceModel();
    ws.initialize(new Map([
      ['file:///story.tw', ':: Start\n{include "Row"}\n\n:: Row [widget]\n{widget "Row"}row{/widget}\n'],
      ['file:///app.ts', 'const html = `\n:: NotAPassage\n${Row}\n[[Start]]\n`;\n'],
    ]));

    expect(ws.passages.getPassagesInDocument('file:///app.ts')).toEqual([]);
    expect(ws.passages.getPassage('NotAPassage')).toBeUndefined();
    // `${Row}` in JS is not a widget invocation: Row stays include-only
    expect(computeDiagnostics('file:///story.tw', ws).map(d => d.code)).toContain('SP303');
    expect(findWidgetReferences('Row', ws, false).map(l => l.uri)).not.toContain('file:///app.ts');
    expect(findPassageReferences('Start', ws, false).map(l => l.uri)).not.toContain('file:///app.ts');
    ws.dispose();
  });

  it('removes stale discovered macros when the source changes', () => {
    const ws = new WorkspaceModel();
    ws.initialize(new Map([['file:///story.tw', storyInit('hello')]]));
    expect(sp100(ws, 'file:///story.tw')).toEqual([]);

    ws.documents.update('file:///story.tw', storyInit('goodbye'));
    expect(ws.macros.getMacro('hello')).toBeUndefined();
    expect(ws.macros.getMacro('goodbye')).toBeDefined();
    expect(sp100(ws, 'file:///story.tw')).toEqual(['Unknown macro {hello}.']);

    ws.documents.update('file:///story.tw', storyInit('hello'));
    expect(sp100(ws, 'file:///story.tw')).toEqual([]);
    ws.dispose();
  });

  it('removes discovered macros when the defining document closes', () => {
    const ws = new WorkspaceModel();
    ws.initialize(new Map([
      ['file:///init.tw', ':: StoryInit\n{do}Story.defineMacro({ name: "hello", render: () => null});{/do}\n'],
      ['file:///start.tw', ':: Start\n{hello}\n'],
    ]));
    expect(sp100(ws, 'file:///start.tw')).toEqual([]);

    ws.documents.close('file:///init.tw');
    expect(sp100(ws, 'file:///start.tw')).toEqual(['Unknown macro {hello}.']);
    ws.dispose();
  });

  it('ignores Story.defineMacro outside StoryInit {do} blocks and script passages', () => {
    const ws = new WorkspaceModel();
    ws.initialize(new Map([['file:///story.tw', `:: Other
{do}Story.defineMacro({ name: "hello", render: () => null});{/do}

:: Start
{hello}
`]]));
    expect(ws.macros.getMacro('hello')).toBeUndefined();
    ws.dispose();
  });
});
