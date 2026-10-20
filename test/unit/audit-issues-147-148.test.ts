import { afterEach, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { compile } from '@rohal12/twee-ts';
import { openPlaySession } from '@rohal12/spindle/play';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { getCompletions } from '../../src/plugins/completions.js';
import { computeRename, prepareRename } from '../../src/plugins/rename.js';

const uri = 'file:///story.tw';
const metadata = ':: StoryTitle\nExample\n:: StoryData\n{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"}\n';
const compilerOptions = {
  formatId: 'pkg',
  formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
  noRemote: true,
  useTweegoPath: false,
};
const models: WorkspaceModel[] = [];
function workspace(text: string) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text]]));
  return model;
}
afterEach(() => models.splice(0).forEach(model => model.dispose()));

const parent = (name: string, children: string[] = []) =>
  `Story.defineMacro({name:${JSON.stringify(name)},block:true,subMacros:${JSON.stringify(children)},render(){return null;}});`;

for (const phase of ['script', 'StoryInit']) {
  it(`drops superseded child macros in ${phase}, matching startup validation (#147)`, async () => {
    const original = parent('outer', ['branch', 'kept']);
    const replacement = parent('OUTER', ['kept']);
    const text = `${metadata}:: StoryVariables\n:: Code [script]\n${original}${phase === 'script' ? replacement : ''}\n`
      + (phase === 'StoryInit' ? `:: StoryInit\n{do}${replacement}{/do}\n` : '')
      + ':: Start\n{outer}{branch}{kept}{/outer}';
    const model = workspace(text);
    expect(model.macros.getMacro('branch')).toBeUndefined();
    expect(model.macros.getMacro('kept')?.parents).toEqual(['OUTER']);
    expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP100').map(d => d.message)).toEqual(['Unknown macro {branch}.']);
    const compiled = await compile({ sources: [{ filename: uri, content: text }], ...compilerOptions });
    expect(compiled.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    await expect(openPlaySession({ html: compiled.output })).rejects.toThrow('Unknown macro {branch}');
    const line = text.split('\n').length - 1;
    const completions = getCompletions(uri, { line, character: 9 }, undefined, model).map(c => c.label);
    expect(completions).toContain('kept');
    expect(completions).not.toContain('branch');

    // Definition edits replace the discovered layer, dropping and restoring companions.
    model.documents.update(uri, text.replace(original, parent('outer', ['edited'])));
    expect(model.macros.getMacro('edited')).toBeUndefined();
    model.documents.update(uri, text.replace(replacement, parent('OUTER', ['branch', 'kept'])));
    expect(model.macros.getMacro('branch')?.parents).toEqual(['OUTER']);
    expect(computeDiagnostics(uri, model).filter(d => d.severity === 'error')).toEqual([]);
  });
}

it('keeps shared companions and independently defined macros when their old parent is replaced (#147)', () => {
  const text = `${metadata}:: StoryVariables\n:: Code [script]\n`
    + parent('old', ['shared', 'independent', 'removed'])
    + parent('surviving', ['shared'])
    + 'Story.defineMacro({name:"independent",block:true,parameters:[{name:"x",type:"number"}],render(){return null;}});'
    + parent('old')
    + '\n:: Start\n{surviving}{shared}{/surviving}{independent 1}{/independent}';
  const model = workspace(text);
  expect(model.macros.getMacro('removed')).toBeUndefined();
  expect(model.macros.getMacro('shared')?.parents).toEqual(['surviving']);
  expect(model.macros.getMacro('independent')).toMatchObject({ block: true, parameterDefs: [{ name: 'x', type: 'number' }] });
  expect(model.macros.getMacro('independent')?.parents).toBeUndefined();
  expect(computeDiagnostics(uri, model).filter(d => d.severity === 'error')).toEqual([]);
  model.documents.update(uri, text.replace(parent('old'), parent('old', ['shared'])));
  expect(model.macros.getMacro('shared')?.parents).toEqual(['old', 'surviving']);
});

it.each(['StoryData', 'StoryTitle', 'StorySettings', 'StoryIncludes'])(
  'rejects both directions of compiler-special %s renames atomically (#148)', name => {
    const model = workspace(`:: ${name}\nmetadata\n:: Ordinary\n[[${name}]]`);
    for (const position of [{ line: 0, character: 4 }, { line: 3, character: 4 }]) {
      expect(prepareRename(uri, position, model)).toBeNull();
      expect(computeRename(uri, position, 'Renamed', model).size).toBe(0);
    }
    const ordinary = workspace(':: Ordinary\nHello');
    expect(() => computeRename(uri, { line: 0, character: 4 }, name, ordinary)).toThrow(/reserved passage name/);
  },
);

it('preserves StorySettings IFID through rejected renames and still compiles ordinary applied edits (#148)', async () => {
  const text = ':: StoryTitle\nExample\n:: StoryVariables\n:: Start\n[[Ordinary]]\n:: StorySettings\nifid: 7E95B777-0E72-4603-AA57-049388D05756\n:: Ordinary\nHello';
  const model = workspace(text);
  const edits = computeRename(uri, { line: 5, character: 4 }, 'Settings', model);
  const document = TextDocument.create(uri, 'twee', 0, text);
  expect(TextDocument.applyEdits(document, edits.get(uri) ?? [])).toBe(text);
  const ordinary = computeRename(uri, { line: 7, character: 4 }, 'Renamed', model);
  const content = TextDocument.applyEdits(document, ordinary.get(uri)!);
  expect(content).toContain('[[Renamed]]');
  expect(content).toContain(':: Renamed\nHello');
  for (const source of [text, content]) {
    const compiled = await compile({ sources: [{ filename: uri, content: source }], ...compilerOptions });
    expect(compiled.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(compiled.story.ifid).toBe('7E95B777-0E72-4603-AA57-049388D05756');
  }
});
