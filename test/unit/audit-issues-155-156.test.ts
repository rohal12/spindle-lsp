import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { compile } from '@rohal12/twee-ts';
import { openPlaySession } from '@rohal12/spindle/play';
import { builtinMacros, discoverMacros, validateStoryMarkup } from '@rohal12/spindle/tooling';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { getHoverInfo } from '../../src/plugins/hover.js';
import { getSignatureHelp, signaturePlugin } from '../../src/plugins/signature.js';

const uri = 'file:///story.tw';
const models: WorkspaceModel[] = [];
function workspace(body: string, script?: string) {
  const model = new WorkspaceModel();
  models.push(model);
  const files = new Map([[uri, `:: StoryVariables\n:: Start\n${body}`]]);
  if (script) files.set('file:///macros.js', script);
  model.initialize(files);
  return model;
}
afterEach(() => models.splice(0).forEach(model => model.dispose()));

describe('runtime help (#155)', () => {
  it.each(builtinMacros.filter(m => m.parameters?.length))('uses runtime parameter structure for $name', macro => {
    const body = `{${macro.name} `;
    const model = workspace(body);
    const help = getSignatureHelp(uri, { line: 2, character: body.length }, model)!;
    const names = macro.parameters!.map(p => p.required || p.type === 'separator' ? p.name : `[${p.name}]`);
    expect(help.signatures).toHaveLength(1);
    expect(help.signatures[0].label).toBe(`{${[macro.name, ...names].join(' ')}}`);
    const positional = macro.parameters!.every(p => p.type === 'string' || p.type === 'number');
    expect(help.signatures[0].parameters.map(p => p.label)).toEqual(positional ? names : []);
    expect(help.activeParameter).toBe(0);
    const docs = [help.signatures[0].documentation, ...help.signatures[0].parameters.map(p => p.documentation)].join('\n');
    for (const parameter of macro.parameters!) expect(docs).toContain(`Type: ${parameter.type}`);
  });

  it.each([
    ['{if ', '{if ...condition}'],
    ['{custom ', '{custom number text}'],
  ])('retains supplement schemas when runtime metadata is absent in %s', (body, label) => {
    const model = workspace(body);
    model.macros.loadSupplements({ custom: { parameters: ['number &+ text'] } });
    expect(getSignatureHelp(uri, { line: 2, character: body.length }, model)?.signatures[0].label).toBe(label);
  });

  it('returns the computed assignment signature over LSP, without guessing parameter spans', () => {
    const body = '{computed _n = 1 + 2 ';
    const model = workspace(body);
    let handler: (params: any) => any;
    signaturePlugin.initialize({ connection: { onSignatureHelp: (h: any) => { handler = h; } }, workspace: model } as any);
    const result = handler!({ textDocument: { uri }, position: { line: 2, character: body.length } });
    expect(result.signatures[0]).toMatchObject({ label: '{computed target = expression}', parameters: [] });
    expect(result.signatures[0].documentation).toContain('produces no output');
    expect(result.signatures[0].documentation).toContain('Type: variable');
    expect(result.signatures[0].documentation).toContain('Type: expression');
  });

  it('keeps explicit project schemas, including empty schemas, and restores runtime help when removed', () => {
    const body = '{COMPUTED ';
    const model = workspace(body);
    const help = () => getSignatureHelp(uri, { line: 2, character: body.length }, model);
    model.macros.loadConfig({ computed: { parameters: ['number &+ text'], parameterDocs: [{ name: 'count' }, { name: 'value' }] } });
    expect(help()?.signatures[0].label).toBe('{COMPUTED count value}');
    model.macros.loadConfig({ computed: { parameters: [] } });
    expect(help()).toBeNull();
    model.macros.loadConfig({ computed: { description: 'Project help' } });
    expect(help()?.signatures[0]).toMatchObject({ label: '{COMPUTED target = expression}' });
    expect(help()?.signatures[0].documentation).toContain('Project help');
    model.macros.loadConfig({});
    expect(help()?.signatures[0].documentation).toContain('produces no output');
  });

  it.each([
    ['computed', '{computed _total = 1 + 2}', 'Assigns an expression', 'Value: 3'],
    ['do', '{do}_total = 1 + 2;{/do}', 'Executes JavaScript statements', 'Value: 3'],
    ['passage', '{passage}', "Renders the current passage's contents", 'Start'],
  ])('runs the example advertised by %s hover against the bundled runtime', async (name, markup, description, output) => {
    const model = workspace(markup);
    const hover = getHoverInfo(uri, { line: 2, character: 2 }, model)!;
    expect(hover.contents).toContain(description);
    // Run the actual example shown to the author, rather than a separate
    // hand-maintained copy that can drift away from the hover text.
    const example = name === 'do'
      ? /```\n([\s\S]*?)\n```/.exec(hover.contents)![1]
      : /Usage(?: in StoryInterface)?: `([^`]+)`/.exec(hover.contents)![1];
    const layout = name === 'passage' ? example : '<main>{passage}</main>';
    const body = name === 'passage' ? /use `([^`]+)`/.exec(hover.contents)![1] : example;
    const source = ':: StoryTitle\nHelp examples\n:: StoryData\n{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"}\n'
      + `:: StoryVariables\n:: StoryInterface\n${layout}\n:: Start\n${body}`;
    const compiled = await compile({
      sources: [{ filename: uri, content: source }],
      formatId: 'pkg',
      formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
      noRemote: true,
      useTweegoPath: false,
    });
    expect(compiled.diagnostics).toEqual([]);
    const session = await openPlaySession({ html: compiled.output, trusted: true });
    try { expect(await session.observe()).toMatchObject({ text: output, errors: [] }); }
    finally { await session.close(); }
  });
});

describe('tooling owns custom branch diagnostics (#156)', () => {
  const script = 'Story.defineMacro({name:"panel",block:true,subMacros:["tab"],render(){return null;}});';
  it.each([
    '{tab}',
    '{panel}{tab}{/panel}',
    '{panel}<b>{tab}</b>{/panel}',
    '{button "{tab}"}Go{/button}',
    '<span title="{tab}">Go</span>',
    '{PANEL}<b>{TAB}</b>{/PANEL}',
    '{tab}{tab}',
  ])('maps each public misplaced-branch diagnostic exactly once in %s', body => {
    const model = workspace(body, script);
    const expected = validateStoryMarkup([{ name: 'Start', content: body }], [...builtinMacros, ...discoverMacros(script)], { tolerant: true })
      .filter(d => d.code === 'misplaced-branch');
    const passage = model.markup.get(uri)!.passages[1];
    const diagnostics = computeDiagnostics(uri, model);
    expect(diagnostics).toEqual(expected.map(d => expect.objectContaining({
      code: 'SP107', message: d.message, range: passage.range(d.start, d.end),
    })));
  });

  it('retains parent constraints for macros configured without sub-macro metadata', () => {
    const model = workspace('{child}');
    model.macros.loadConfig({ parent: { container: true }, child: { parents: ['parent'] } });
    expect(computeDiagnostics(uri, model)).toEqual([expect.objectContaining({
      code: 'SP107', message: 'Invalid: {child} can only be inside {parent}',
    })]);
  });

  it.each([
    '{option "a"}',
    '{listbox "_choice"}<b>{option "a"}</b>{/listbox}',
  ])('retains value-child constraints when a project replaces listbox: %s', body => {
    const definition = 'Story.defineMacro({name:"listbox",block:true,subMacros:["option"],render(){return null;}});';
    const model = workspace(body, definition);
    // Tooling treats listbox's sub-macros as values, not branches, even
    // when the project replaces that macro's runtime definition.
    const macros = [...builtinMacros.filter(macro => macro.name !== 'listbox'), ...discoverMacros(definition)];
    expect(validateStoryMarkup([{ name: 'Start', content: body }], macros, { tolerant: true })).toEqual([]);
    expect(computeDiagnostics(uri, model)).toEqual([expect.objectContaining({
      code: 'SP107', message: expect.stringContaining('can only be directly inside {listbox}'),
    })]);
  });
});
