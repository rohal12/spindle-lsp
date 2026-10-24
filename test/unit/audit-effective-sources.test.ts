import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from '@rohal12/twee-ts';
import { openPlaySession } from '@rohal12/spindle/play';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeRename } from '../../src/plugins/rename.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { getCompletions } from '../../src/plugins/completions.js';

const metadata = ':: StoryTitle\nExample\n:: StoryData\n{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"}\n';
const models: WorkspaceModel[] = [];
const directories: string[] = [];
afterEach(() => {
  models.splice(0).forEach(model => model.dispose());
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});
function fixture(entries: Array<[string, string]>) {
  const directory = mkdtempSync(join(tmpdir(), 'spindle-effective-'));
  directories.push(directory);
  const files = new Map(entries.map(([name, text]) => [pathToFileURL(join(directory, name)).href, text]));
  return { directory, files, uri: pathToFileURL(join(directory, 'story.tw')).href };
}
function workspace(files: Map<string, string>) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(files);
  return model;
}
const doc = (uri: string, text: string) => TextDocument.create(uri, 'twee3', 1, text);
function renamed(files: Map<string, string>, uri: string, model: WorkspaceModel) {
  const text = files.get(uri)!;
  const at = doc(uri, text).positionAt(text.indexOf('$x =') + 1);
  const edits = computeRename(uri, at, 'y', model);
  return new Map([...files].map(([path, content]) => [path, TextDocument.applyEdits(doc(path, content), edits.get(path) ?? [])]));
}
async function rendered(directory: string, files: Map<string, string>) {
  for (const [uri, text] of files) {
    const path = fileURLToPath(uri);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  const result = await compile({
    sources: [directory], formatId: 'pkg',
    formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
    noRemote: true, useTweegoPath: false,
  });
  expect(result.diagnostics.filter(d => d.level === 'error')).toEqual([]);
  const session = await openPlaySession({ html: result.output, trusted: true });
  try {
    const observation = await session.observe();
    expect(observation.errors).toEqual([]);
    return observation.text;
  } finally { await session.close(); }
}

for (const [early, late] of [['a/early', 'a'], ['z', 'é'], ['z', '😀']]) {
  for (const kind of ['widget', 'script', 'js']) for (const reverse of [false, true]) {
    it(`preserves literal arguments in compiler ${kind} source order ${early}/${late}, reverse=${reverse} (#176)`, async () => {
      const definition = (markup: boolean) => kind === 'widget'
        ? `:: ${markup ? 'Early' : 'Late'} [widget]\n{widget "caption" @v${markup ? ':markup' : ''}}${markup ? 'EARLY' : 'LATE'}:{@v}{/widget}\n`
        : `${kind === 'script' ? `:: ${markup ? 'Early' : 'Late'} [script]\n` : ''}Story.defineMacro({name:"caption",parameters:[{name:"v",type:"string"${markup ? ',holds:"markup"' : ''}}],render(_props,ctx){return "${markup ? 'EARLY' : 'LATE'}:"+ctx.args.v;}});\n`;
      const extension = kind === 'js' ? 'js' : 'tw';
      const setup = fixture([
        ['story.tw', `${metadata}:: StoryVariables\n$x = 7\n:: Start\n{caption "{$x}"}\n`],
        [`${early}.${extension}`, definition(true)], [`${late}.${extension}`, definition(false)],
      ]);
      const files = reverse ? new Map([...setup.files].reverse()) : setup.files;
      const model = workspace(files);
      expect(await rendered(setup.directory, files)).toBe('LATE:{$x}');
      const changed = renamed(files, setup.uri, model);
      expect(changed.get(setup.uri)).toContain('{caption "{$x}"}');
      expect(await rendered(setup.directory, changed)).toBe('LATE:{$x}');
    });
  }
}

for (const separate of [false, true]) {
  it(`ignores discarded macro and widget definitions, separate=${separate} (#177)`, async () => {
    const discarded = ':: Macros [script]\nStory.defineMacro({name:"textbox",parameters:[{name:"label",type:"string"}],render(){return null;}});\n:: W [widget]\n{widget "caption"}discarded{/widget}\n';
    const replacement = ':: Macros\nordinary\n:: W [widget]\n{widget "other"}other{/widget}\n';
    const setup = fixture([
      ['story.tw', `${metadata}:: StoryVariables\n$x = "old"\n${discarded}${separate ? '' : replacement}:: Start\n{textbox "$x"}\n`],
      ...(separate ? [['z.tw', replacement] as [string, string]] : []),
    ]);
    const model = workspace(new Map([...setup.files].reverse()));
    expect(await rendered(setup.directory, setup.files)).toBe('[textbox $x: "old"]');
    expect(model.variables.getUsages('x')).toHaveLength(1);
    expect(model.widgets.getWidget('caption')).toBeUndefined();
    const changed = renamed(setup.files, setup.uri, model);
    expect(changed.get(setup.uri)).toContain('{textbox "$y"}');
    expect(await rendered(setup.directory, changed)).toBe('[textbox $y: "old"]');
    const text = setup.files.get(setup.uri)!;
    model.documents.update(setup.uri, text.replace('{textbox "$x"}', '{caption}'));
    expect(computeDiagnostics(setup.uri, model).filter(d => d.code === 'SP100')).toHaveLength(1);
    expect(model.passages.getPassages('Macros')).toHaveLength(2);
  });
}

it.each(['Twine.private', 'script', 'stylesheet'])('does not resurrect a superseded destination before %s exclusion (#177)', tag => {
  const setup = fixture([['story.tw', `:: StoryVariables\n:: Start\n[[Hall]]\n:: Hall\nroom\n:: Hall [${tag}]\n`]]);
  const model = workspace(setup.files);
  expect(computeDiagnostics(setup.uri, model).filter(d => d.code === 'SP300')).toHaveLength(1);
  expect(getCompletions(setup.uri, { line: 2, character: 4 }, undefined, model).map(item => item.label)).not.toContain('Hall');
  expect(model.passages.getPassages('Hall')).toHaveLength(2);
});

it('invalidates effective discoveries and destinations on unsaved replacement and removal (#177)', () => {
  const setup = fixture([
    ['story.tw', ':: StoryVariables\n$x = "old"\n:: Macros [script]\nStory.defineMacro({name:"textbox",parameters:[{name:"v",type:"string"}],render(){return null;}});\n:: Hall\nroom\n:: Start\n{textbox "$x"}[[Hall]]\n'],
    ['z.tw', ':: Macros\nordinary\n:: Hall [Twine.private]\n'],
  ]);
  const model = workspace(setup.files);
  const later = [...setup.files.keys()][1];
  expect(model.variables.getUsages('x')).toHaveLength(1);
  expect(computeDiagnostics(setup.uri, model).filter(d => d.code === 'SP300')).toHaveLength(1);
  model.documents.update(later, '');
  expect(model.variables.getUsages('x')).toHaveLength(0);
  expect(computeDiagnostics(setup.uri, model).filter(d => d.code === 'SP300')).toHaveLength(0);
  model.documents.update(later, setup.files.get(later)!);
  expect(model.variables.getUsages('x')).toHaveLength(1);
  model.documents.close(later);
  expect(model.variables.getUsages('x')).toHaveLength(0);
});

it.each(['widget', 'script', 'js'])('keeps a replaced passage in its first compiler slot relative to %s sources (#177)', async kind => {
  const a = (markup: boolean) => `:: A [${kind === 'widget' ? 'widget' : 'script'}]\n${kind === 'widget'
    ? `{widget "caption" @v${markup ? ':markup' : ''}}A:{@v}{/widget}`
    : `Story.defineMacro({name:"caption",parameters:[{name:"v",type:"string"${markup ? ',holds:"markup"' : ''}}],render(_p,c){return "A:"+c.args.v;}});`}\n`;
  const b = kind === 'widget' ? ':: B [widget]\n{widget "caption" @v}B:{@v}{/widget}\n' : `${kind === 'script' ? ':: B [script]\n' : ''}Story.defineMacro({name:"caption",parameters:[{name:"v",type:"string"}],render(_p,c){return "B:"+c.args.v;}});\n`;
  const setup = fixture([
    ['story.tw', `${metadata}:: StoryVariables\n$x = 7\n:: Start\n{caption "{$x}"}\n`],
    ['a.tw', a(false)], [kind === 'js' ? 'b.js' : 'b.tw', b], ['z.tw', a(true)],
  ]);
  const model = workspace(setup.files);
  expect(await rendered(setup.directory, setup.files)).toBe('B:{$x}');
  const changed = renamed(setup.files, setup.uri, model);
  expect(changed.get(setup.uri)).toContain('{caption "{$x}"}');
  expect(await rendered(setup.directory, changed)).toBe('B:{$x}');
});

it('keeps editor navigation for an unfinished replacement without restoring discarded runtime widgets (#177)', () => {
  const setup = fixture([
    ['story.tw', ':: StoryVariables\n$x = 7\n:: Shared [widget]\n{widget "caption" @v:markup}{@v}{/widget}\n:: Start\n{caption "{$x}"}\n'],
    ['z.tw', ':: Shared [widget]\n{widget "caption" @unfinished @extra}\n'],
  ]);
  const model = workspace(setup.files);
  const widget = model.widgets.getWidget('caption');
  expect(widget?.uri).toBe(setup.uri);
  expect(widget?.params).toEqual(['@v']);
  expect(model.widgets.getAllWidgets()).toEqual([]);
});

it('excludes discarded body references and diagnostics while retaining their source markup (#177)', () => {
  const text = ':: StoryVariables\n$x = 1\n:: Draft\n{$ghost}{missing}[[Hall{$x}]]\n:: Draft\n{$x}\n';
  const setup = fixture([['story.tw', text]]);
  const model = workspace(setup.files);
  expect(model.variables.getUsages('ghost')).toEqual([]);
  expect(model.variables.getUsages('x')).toHaveLength(1);
  expect(computeDiagnostics(setup.uri, model).filter(d => ['SP100', 'SP200', 'SP300', 'SP305'].includes(String(d.code)))).toEqual([]);
  expect(model.markup.get(setup.uri)?.passages[1].content).toBe('{$ghost}{missing}[[Hall{$x}]]\n');
});

it.each(['script', 'js'])('keeps live textbox references when %s replaces do before StoryInit (#180)', async kind => {
  const replacement = 'Story.defineMacro({name:"do",block:true,render(){return null;}});';
  const setup = fixture([
    ['story.tw', `${metadata}:: StoryVariables\n$x = "old"\n${kind === 'script' ? `:: Macros [script]\n${replacement}\n` : ''}:: StoryInit\n{do}Story.defineMacro({name:"textbox",parameters:[{name:"label",type:"string"}],render(){return null;}});{/do}\n:: Start\n{textbox "$x"}\n`],
    ...(kind === 'js' ? [['macros.js', replacement] as [string, string]] : []),
  ]);
  const model = workspace(setup.files);
  expect(model.macros.hasDiscoveredMacro('textbox')).toBe(false);
  expect(model.variables.getUsages('x')).toHaveLength(1);
  expect(computeDiagnostics(setup.uri, model)).toEqual([]);
  expect(await rendered(setup.directory, setup.files)).toBe('[textbox $x: "old"]');
  const changed = renamed(setup.files, setup.uri, model);
  expect(changed.get(setup.uri)).toContain('{textbox "$y"}');
  expect(await rendered(setup.directory, changed)).toBe('[textbox $y: "old"]');
});

it('refreshes executable StoryInit discovery after unsaved script replacements (#180)', () => {
  const replacement = 'Story.defineMacro({name:"do",block:true,render(){return null;}});';
  const setup = fixture([
    ['story.tw', ':: StoryVariables\n$x = "old"\n:: StoryInit\n{do}Story.defineMacro({name:"textbox",parameters:[{name:"label",type:"string"}],render(){return null;}});{/do}\n:: Start\n{textbox "$x"}\n'],
    ['macros.js', replacement],
  ]);
  const model = workspace(setup.files);
  const script = [...setup.files.keys()][1];
  expect(model.macros.hasDiscoveredMacro('textbox')).toBe(false);
  expect(model.variables.getUsages('x')).toHaveLength(1);
  model.documents.update(script, '');
  expect(model.macros.hasDiscoveredMacro('textbox')).toBe(true);
  expect(model.variables.getUsages('x')).toHaveLength(0);
  model.documents.update(script, replacement);
  expect(model.macros.hasDiscoveredMacro('textbox')).toBe(false);
  expect(model.variables.getUsages('x')).toHaveLength(1);
  model.documents.close(script);
  expect(model.macros.hasDiscoveredMacro('textbox')).toBe(true);
  expect(model.variables.getUsages('x')).toHaveLength(0);
});
