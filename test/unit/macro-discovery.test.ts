import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { discoverMacros } from '@rohal12/spindle/tooling';
import { MacroRegistry } from '../../src/core/workspace/macro-registry.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { findPassageReferences, findWidgetReferences } from '../../src/plugins/references.js';

/** The workspace of one JavaScript document, which only feeds macro discovery. */
function workspaceWith(source: string): WorkspaceModel {
  const ws = new WorkspaceModel();
  ws.initialize(new Map([['file:///macros.js', source]]));
  return ws;
}

/** The names of the macros a workspace of `files` knows besides those of an empty one. */
function definedMacros(files: Map<string, string>): string[] {
  const names = (map: Map<string, string>): string[] => {
    const ws = new WorkspaceModel();
    ws.initialize(map);
    const found = ws.macros.getAllMacros().map(m => m.name);
    ws.dispose();
    return found;
  };
  const known = new Set(names(new Map()));
  return names(files).filter(name => !known.has(name));
}

/** The registry of the macros that `source` defines, on top of the built-ins. */
function registryWith(source: string): MacroRegistry {
  const registry = new MacroRegistry();
  registry.loadBuiltins();
  registry.setDiscoveredMacros(discoverMacros(source));
  return registry;
}

describe('macros defined in project JS/TS files', () => {
  it('registers the macros of a TS file with their flags and description', () => {
    const ws = workspaceWith(readFileSync(resolve(__dirname, '../fixtures/custom-macros.ts'), 'utf-8'));
    expect(ws.macros.getMacro('agebox')).toMatchObject({
      source: 'user', block: false, storeVar: true, description: 'Age selection box',
    });
    expect(ws.macros.getMacro('chargenOption')).toMatchObject({ block: true, merged: true, subMacros: ['option'] });
    expect(ws.macros.getMacro('option')).toMatchObject({ block: false, parents: expect.arrayContaining(['chargenOption']) });
    ws.dispose();
  });

  it('registers nothing for source without a definition or with a name that is not a string', () => {
    for (const source of ['const x = 1;', 'Story.defineMacro({ name: computed() });']) {
      expect(definedMacros(new Map([['file:///macros.js', source]]))).toEqual([]);
    }
  });

  it('infers block from the sub-macros like defineMacro does', () => {
    const ws = workspaceWith(`
      Story.defineMacro({ name: 'dialog', subMacros: ['say'] });
      Story.defineMacro({ name: 'plain', subMacros: ['x'], block: false });
    `);
    expect(ws.macros.getMacro('dialog')?.block).toBe(true);
    expect(ws.macros.getMacro('plain')?.block).toBe(false);
    ws.dispose();
  });

  it('reads the fields of the config, not those of a nested object or a comment', () => {
    const registry = registryWith(`Story.defineMacro({
  /* name: "wrong", block: true */
  render() { const o = { name: "inner", storeVar: true }; return o; },
  name: "outer",
  subMacros: ['a', "b"],
});`);
    expect(registry.getMacro('outer')).toMatchObject({ block: true, subMacros: ['a', 'b'] });
    expect(registry.getMacro('outer')?.storeVar).toBeUndefined();
    expect(registry.getMacro('wrong')).toBeUndefined();
    expect(registry.getMacro('inner')).toBeUndefined();
  });

  it('reads definitions that are not written as Story.defineMacro({ ... }) (the tooling API wins)', () => {
    const registry = registryWith(`
      defineMacro({ name: 'bare' });
      const config = { name: 'viaVariable', block: true };
      Story.defineMacro(config);
    `);
    expect(registry.getMacro('bare')?.source).toBe('user');
    expect(registry.getMacro('viaVariable')?.block).toBe(true);
  });
});

describe('typed parameters of a definition', () => {
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

  it('reaches the registry, options included', () => {
    const registry = registryWith(source);
    expect(registry.getMacro('damage')).toMatchObject({ description: 'Apply damage', merged: true, block: false });
    expect(registry.getMacro('damage')?.parameterDefs).toEqual([
      { name: 'target', type: 'variable', required: true, description: 'The $variable' },
      { name: 'amount', type: 'expression', required: true },
      { name: 'label', type: 'text', holds: 'markup' },
      { name: 'mode', type: 'options', parameters: [{ name: 'fast', type: 'flag' }, { name: 'by', type: 'string' }] },
    ]);
    expect(registry.toolingMacros().find(m => m.name === 'damage')?.parameters).toHaveLength(4);
  });

  it('are absent when the definition declares none or one that Spindle rejects', () => {
    const parametersOf = (config: string) =>
      registryWith(`Story.defineMacro({ name: "a", ${config} render() {} });`).getMacro('a')?.parameterDefs;
    expect(parametersOf('')).toBeUndefined();
    // No type, or one that is not in the table: Story.defineMacro() throws, so the macro has no parameters
    expect(parametersOf('parameters: [{ name: "p" }],')).toBeUndefined();
    expect(parametersOf('parameters: [{ name: "p", type: "bogus" }],')).toBeUndefined();
    expect(parametersOf('parameters: params,')).toBeUndefined();
  });

  it('can be an empty list', () => {
    expect(registryWith('Story.defineMacro({ name: "a", parameters: [], render() {} });').getMacro('a')?.parameterDefs).toEqual([]);
  });

  it('replace those of the built-in macro they redefine, until they are gone', () => {
    const registry = registryWith('Story.defineMacro({ name: "set", render() {} });');
    expect(registry.getMacro('set')?.parameterDefs).toBeUndefined();
    registry.setDiscoveredMacros([]);
    expect(registry.getMacro('set')?.parameterDefs?.length).toBeGreaterThan(0);
  });

  it('carry storeVar to the tooling API', () => {
    const registry = registryWith('Story.defineMacro({ name: "agebox", storeVar: true });');
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
    expect(computeDiagnostics('file:///story.tw', ws).filter(d => d.code === 'SP200').map(d => d.message)).toEqual([
      'Undeclared variable: $str',
      'Undeclared variable: $undeclared',
    ]);
    expect(ws.variables.getUsages('text')).toEqual([]);
    ws.dispose();
  });
});

describe('macros defined in StoryInit', () => {
  const definedIn = (story: string): string[] => definedMacros(new Map([['file:///story.tw', story]]));

  it('extracts from the {do} body', () => {
    const ws = new WorkspaceModel();
    ws.initialize(new Map([['file:///story.tw', `:: StoryInit
{do}
Story.defineMacro({
  name: 'custom',
  block: true,
  render: () => null,
});
{/do}
`]]));
    expect(ws.macros.getMacro('custom')).toMatchObject({ source: 'user', block: true });
    ws.dispose();
  });

  it('reads the {do} bodies as the tokenizer does', () => {
    const define = (name: string) => `Story.defineMacro({ name: "${name}", render: () => null });`;
    expect(definedIn([
      ':: StoryInit',
      `{DO}${define('upper')}{/DO}`,
      `<!-- {do}${define('commented')}{/do} -->`,
      `{print "{do}${define('instring')}{/do}"}`,
      `{do}\r\n${define('crlf')}\r\n{/do}`,
    ].join('\n'))).toEqual(['upper', 'crlf']);
  });
});

describe('MacroRegistry discovered macros', () => {
  it('adds discovered macros and infers block from subMacros like Story.defineMacro', () => {
    const registry = new MacroRegistry();
    registry.setDiscoveredMacros(discoverMacros(`
      Story.defineMacro({ name: 'dialog', subMacros: ['say'], description: 'A dialog' });
      Story.defineMacro({ name: 'plain', subMacros: ['x'], block: false });
    `));

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

    registry.setDiscoveredMacros(discoverMacros("Story.defineMacro({ name: 'set', block: true }); Story.defineMacro({ name: 'hello' });"));
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
      registry.setDiscoveredMacros(discoverMacros("Story.defineMacro({ name: 'hello', block: true, storeVar: true, description: 'Discovered' });"));
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
