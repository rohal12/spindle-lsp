import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { builtinMacros, validateStoryMarkup } from '@rohal12/spindle/tooling';
import { deepTokens } from '../helpers/tooling.js';

const uri = 'file:///story.tw';
let workspace: WorkspaceModel;
afterEach(() => { vi.restoreAllMocks(); workspace?.dispose(); });

it.each([
  [64, 'nosuch', 64], [128, 'nosuch', 128], [128, 'print 1', 0],
] as const)('bounds token visits for %i repeated {%s} calls (#253)', (count, macro, errors) => {
  workspace = new WorkspaceModel();
  workspace.initialize(new Map([[uri, ':: StoryVariables\n:: Start\n' + `{${macro}}\n`.repeat(count)]]));
  computeDiagnostics(uri, workspace); // Warm the tooling report and passage analyses.
  const tokens = workspace.markup.get(uri)!.passages[1].tokens;
  let visits = 0;
  Object.defineProperty(tokens, Symbol.iterator, {
    value: function* () {
      for (let i = 0; i < tokens.length; i++) {
        visits++;
        yield tokens[i];
      }
    },
  });
  const diagnostics = computeDiagnostics(uri, workspace);
  expect(diagnostics).toHaveLength(errors);
  expect(diagnostics.every(d => d.code === 'SP100')).toBe(true);
  expect(visits).toBeLessThanOrEqual(tokens.length * 8);
});

it('keeps tooling macro-name ranges in prose, labels and attributes after edits (#253)', () => {
  workspace = new WorkspaceModel();
  const body = '{nosuch}\n[[{absent}|Start]]\n<span title="{missing}">text</span>\n';
  const source = ':: StoryVariables\r\n:: Start\r\n' + body.replaceAll('\n', '\r\n');
  workspace.initialize(new Map([[uri, source]]));
  for (const text of [source, source.replaceAll('nosuch', 'otherUnknown')]) {
    workspace.documents.update(uri, text);
    const doc = TextDocument.create(uri, 'twee', 1, text);
    const content = workspace.markup.get(uri)!.passages[1].content;
    const names = deepTokens(content).flatMap(({ token }) => token.type === 'macro'
      ? [content.slice(token.nameStart, token.nameEnd)] : []);
    const diagnostics = computeDiagnostics(uri, workspace).filter(d => d.code === 'SP100');
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.map(d => d.data?.kind === 'unknown-macro' ? doc.getText(d.data.nameRange) : undefined))
      .toEqual(names);
  }
});

it.each([10, 100])('does not enumerate the whole workspace for each of %i prose passages (#233)', count => {
  workspace = new WorkspaceModel();
  workspace.initialize(new Map([[uri, ':: StoryVariables\n:: Start\nHello\n'
    + Array.from({ length: count }, (_, i) => `:: P${i}\nHello\n`).join('')]]));
  expect(computeDiagnostics(uri, workspace)).toEqual([]);
  const enumerate = vi.spyOn(workspace.passages, 'getEffectivePassages');
  expect(computeDiagnostics(uri, workspace)).toEqual([]);
  expect(enumerate.mock.calls.length).toBeLessThanOrEqual(2);
});

it('shares configured passage validation and refreshes it after edits and replacements (#233)', () => {
  workspace = new WorkspaceModel();
  const text = ':: StoryVariables\n:: Start\n{visit "Target"}\n:: Other\n{visit "Target"}\n:: Target\nHello';
  workspace.initialize(new Map([[uri, text]]));
  workspace.macros.loadSupplements({ visit: { name: 'visit', parameters: ['passage'] } });
  const parameterErrors = () => computeDiagnostics(uri, workspace).filter(d => d.code === 'SP110');
  expect(parameterErrors()).toEqual([]);
  const enumerate = vi.spyOn(workspace.passages, 'getEffectivePassages');
  expect(parameterErrors()).toEqual([]);
  expect(enumerate.mock.calls.length).toBeLessThanOrEqual(2);
  workspace.documents.open('file:///z.tw', ':: Target [script]\n// not a runtime passage');
  expect(parameterErrors()).toHaveLength(2);
  workspace.documents.close('file:///z.tw');
  expect(parameterErrors()).toEqual([]);
  workspace.documents.update(uri, text.replace(':: Target\n', ':: Renamed\n'));
  expect(parameterErrors()).toHaveLength(2);
  workspace.documents.update(uri, text);
  expect(parameterErrors()).toEqual([]);
});

it.each([128, 140_000])('preserves every diagnostic in batches of %i (#262)', count => {
  workspace = new WorkspaceModel();
  const content = '{nosuch}\n'.repeat(count) + '{if }\n';
  workspace.initialize(new Map([[uri, ':: StoryVariables\n:: Start\n' + content]]));
  const expected = validateStoryMarkup([
    { name: 'StoryVariables', content: '' }, { name: 'Start', content },
  ], builtinMacros, { tolerant: true });
  expect(expected).toHaveLength(count + 1);
  const diagnostics = computeDiagnostics(uri, workspace, { maxLineLength: 5 });
  const markup = diagnostics.filter(d => d.code !== 'SP500');
  expect(markup).toHaveLength(expected.length);
  expect(markup.filter(d => d.code === 'SP100')).toHaveLength(count);
  const passage = workspace.markup.get(uri)!.passages[1];
  expect(markup.at(-1)).toMatchObject({
    code: 'SP101', message: expected.find(d => d.code === 'unclosed-block')!.message,
    range: passage.range(content.lastIndexOf('{if }'), content.lastIndexOf('{if }') + 5),
  });
  expect(diagnostics.filter(d => d.code === 'SP500')).toHaveLength(count);
  expect(diagnostics.slice(0, 4).map(d => d.code)).toEqual(['SP100', 'SP500', 'SP100', 'SP500']);
});

it.each([64, 128])('bounds token lookups for %i valid bracket links (#263)', count => {
  workspace = new WorkspaceModel();
  workspace.initialize(new Map([[uri, ':: StoryVariables\n:: Start\n' + '[[Start]]\n'.repeat(count)]]));
  expect(computeDiagnostics(uri, workspace)).toEqual([]);
  const tokens = workspace.markup.get(uri)!.passages[1].tokens;
  let visits = 0;
  const find = tokens.find.bind(tokens);
  vi.spyOn(tokens, 'find').mockImplementation(predicate => find((token, index, array) => {
    visits++;
    return predicate(token, index, array);
  }));
  Object.defineProperty(tokens, Symbol.iterator, {
    value: function* () {
      for (let i = 0; i < tokens.length; i++) {
        visits++;
        yield tokens[i];
      }
    },
  });
  expect(computeDiagnostics(uri, workspace)).toEqual([]);
  expect(visits).toBeLessThanOrEqual(tokens.length * 8);
});

it.each([64, 128])('shares registry enumeration across %i constrained calls (#264)', count => {
  workspace = new WorkspaceModel();
  workspace.macros.loadConfig(Object.fromEntries(Array.from({ length: count }, (_, i) =>
    [`macro${i}`, { parents: ['if'] }])));
  workspace.initialize(new Map([[uri, ':: StoryVariables\n:: Start\n{if true}\n'
    + '{macro0}\n'.repeat(count) + '{/if}\n']]));
  const enumerate = vi.spyOn(workspace.macros, 'getAllMacros');
  expect(computeDiagnostics(uri, workspace)).toEqual([]);
  expect(enumerate.mock.calls.length).toBeLessThanOrEqual(3);
  enumerate.mockClear();
  expect(computeDiagnostics(uri, workspace)).toEqual([]);
  expect(enumerate).not.toHaveBeenCalled();
});

it('refreshes parent ownership after discovered definitions and config change (#264)', () => {
  workspace = new WorkspaceModel();
  workspace.initialize(new Map([[uri, ':: StoryVariables\n:: Start\n{child}\n']]));
  workspace.macros.loadConfig({ child: { parents: ['panel'] } });
  const configured = () => expect(computeDiagnostics(uri, workspace)).toMatchObject([
    { code: 'SP107', message: 'Invalid: {child} can only be inside {panel}' },
  ]);
  configured();
  const script = 'file:///macros.js';
  workspace.documents.open(script, 'Story.defineMacro({name:"panel",block:true,subMacros:["CHILD"]});');
  const expected = validateStoryMarkup([{ name: 'Start', content: '{child}\n' }],
    workspace.markup.get(uri)!.context.macros, { tolerant: true });
  expect(expected).toHaveLength(1);
  expect(computeDiagnostics(uri, workspace)).toMatchObject([{ code: 'SP107', message: expected[0].message }]);
  workspace.documents.update(script, 'Story.defineMacro({name:"panel",block:true,subMacros:[]});');
  configured();
  workspace.macros.loadConfig({ child: { parents: [] } });
  expect(computeDiagnostics(uri, workspace)).toEqual([]);
});


it('refreshes bracket-token offsets and mismatch ranges after edits (#263)', () => {
  workspace = new WorkspaceModel();
  const original = ':: StoryVariables\r\n:: Start\r\n[[valid->Start]]\r\n[[bad->Line\r\nbreak]]\r\n';
  workspace.initialize(new Map([[uri, original]]));
  for (const text of [original, original.replace('[[valid->Start]]', 'prefix [[longer label->Start]]')]) {
    workspace.documents.update(uri, text);
    const mismatches = computeDiagnostics(uri, workspace).filter(d => d.code === 'SP304');
    expect(mismatches).toHaveLength(1);
    expect(TextDocument.create(uri, 'twee', 1, text).getText(mismatches[0].range)).toBe('[[bad->Line\r\nbreak]]');
  }
  workspace.documents.update(uri, original.replace('Line\r\nbreak', 'Start'));
  expect(computeDiagnostics(uri, workspace)).toEqual([]);
});
