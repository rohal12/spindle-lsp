import { afterEach, expect, it, vi } from 'vitest';
import { compile, parseTwee } from '@rohal12/twee-ts';
import { builtinMacros, widgetDefinitions } from '@rohal12/spindle/tooling';
import { openPlaySession } from '@rohal12/spindle/play';
import { fileURLToPath } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { parsePassageHeader } from '../../src/core/parsing/passage-parser.js';
import { widgetSources } from '../../src/core/markup/widgets.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeRename } from '../../src/plugins/rename.js';

const uri = 'file:///a-story.tw';
const extraUri = 'file:///z-widgets.tw';
const metadata = ':: StoryTitle\nExample\n:: StoryData\n'
  + '{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"}\n';
const models: WorkspaceModel[] = [];
function workspace(files: Map<string, string>) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(files);
  return model;
}
const document = (path: string, text: string) => TextDocument.create(path, 'twee3', 1, text);
afterEach(() => {
  vi.restoreAllMocks();
  models.splice(0).forEach(model => model.dispose());
});

async function play(files: Map<string, string>) {
  const result = await compile({
    sources: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([filename, content]) => ({ filename, content })),
    formatId: 'pkg',
    formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
    noRemote: true, useTweegoPath: false,
  });
  expect(result.diagnostics.filter(d => d.level === 'error')).toEqual([]);
  return openPlaySession({ html: result.output, trusted: true });
}

for (const layout of ['same passage', 'separate passages', 'separate files']) {
  it(`renames both tags of a cross-widget block with ${layout} (#267)`, async () => {
    const doWidget = '{widget "do"}{@children}{/widget}\n';
    const wrapWidget = '{widget "wrap"}{do}{@children}{/do}{/widget}\n';
    const start = ':: Start\n{wrap}Hello{/wrap}\n';
    const text = metadata + ':: StoryVariables\n:: A [widget]\n' + doWidget
      + (layout === 'separate files' ? start : (layout === 'separate passages' ? ':: B [widget]\n' : '') + wrapWidget + start);
    const files = new Map([[uri, text]]);
    if (layout === 'separate files') files.set(extraUri, ':: B [widget]\n' + wrapWidget);
    const model = workspace(files);
    const oracle = widgetDefinitions(parseTwee([...files.values()].join('\n')).passages
      .map(passage => ({ name: passage.name, tags: passage.tags, content: passage.text })), builtinMacros);
    expect(oracle.find(def => def.name === 'wrap')?.block).toBe(true);
    expect(model.widgets.getWidget('wrap')?.block).toBe(true);
    const at = document(uri, text).positionAt(text.indexOf('{wrap}') + 2);
    const edits = computeRename(uri, at, 'Frame', model);
    expect([...edits.values()].flat()).toHaveLength(3);
    const changed = new Map([...files].map(([path, source]) => [path,
      TextDocument.applyEdits(document(path, source), edits.get(path) ?? []),
    ]));
    expect(changed.get(uri)).toContain('{Frame}Hello{/Frame}');
    for (const sources of [files, changed]) {
      expect(computeDiagnostics(uri, workspace(sources)).filter(d => d.severity === 'error')).toEqual([]);
      const session = await play(sources);
      try {
        const observation = await session.observe();
        expect(observation.errors).toEqual([]);
        expect(observation.text).toBe('Hello');
      } finally { await session.close(); }
    }
  });
}

it('invalidates block discovery after unsaved do definition edits/removal (#267)', () => {
  const text = ':: StoryVariables\n:: W [widget]\n{widget "wrap"}{do}{@children}{/do}{/widget}\n:: Start\n{wrap}Hi{/wrap}';
  const definition = ':: A [widget]\n{widget "do"}{@children}{/widget}';
  const model = workspace(new Map([[uri, text], [extraUri, definition]]));
  expect(model.widgets.getWidget('wrap')?.block).toBe(true);
  model.documents.update(extraUri, ':: A [widget]\n{widget "other"}{@children}{/widget}');
  expect(model.widgets.getWidget('wrap')?.block).toBe(false);
  model.documents.update(extraUri, definition);
  expect(model.widgets.getWidget('wrap')?.block).toBe(true);
  model.documents.close(extraUri);
  expect(model.widgets.getWidget('wrap')?.block).toBe(false);
});

it('preserves duplicate source identities and StoryInit precedence in batched discovery (#267)', () => {
  const text = ':: StoryInit\n{widget "winner"}init{/widget}\n:: W [widget]\n{widget "early"}a{/widget}\n'
    + ':: W [widget]\n{widget "winner"}tagged{/widget}\n:: StoryInit\n{widget "winner"}later init{/widget}';
  const model = workspace(new Map([[uri, text]]));
  const passages = model.markup.get(uri)!.passages;
  const sources = [...widgetSources(passages, builtinMacros)];
  expect(sources.map(([definition, passage]) => [definition.name, definition.passage, passage])).toEqual([
    ['winner', 'StoryInit', passages[0]], ['early', 'W', passages[1]],
    ['winner', 'W', passages[2]], ['winner', 'StoryInit', passages[3]],
  ]);
  expect(model.widgets.getWidget('winner')?.range.start.line).toBe(7);
});

it.each([100, 200])('visits pieces linearly for %i write-only loop targets on cold and warm checks (#268)', count => {
  const source = ':: StoryVariables\n:: Start\n{for @i of [1]}\n'
    + Array.from({ length: count }, (_, i) => `{set _x${i} = @i}\n`).join('') + '{/for}';
  const model = workspace(new Map([[uri, source]]));
  const passage = model.markup.get(uri)!.passages[1];
  const pieces = passage.pieces;
  let visits = 0;
  const iterator = pieces[Symbol.iterator].bind(pieces);
  vi.spyOn(pieces, Symbol.iterator).mockImplementation(function* () {
    for (const piece of iterator()) { visits++; yield piece; }
  });
  for (let check = 0; check < 2; check++) {
    visits = 0;
    expect(computeDiagnostics(uri, model)).toEqual([]);
    expect(visits).toBeLessThan(20 * pieces.length);
  }
});

it('indexes executable loop reads, excludes the assignment and invalidates on edits (#268)', () => {
  const body = '{for @i of [1]}{set _x = @i}{set _self = @i, @copy = _self}'
    + '{for @j of [2]}{set _y = @j}{_y}{/for}'
    + '{button "Go"}{set _deferred = @i}{_deferred}{/button}'
    + '{watch "true" run "console.log(\\"ok\\", _x)"}{/for}';
  const text = `:: StoryVariables\r\n:: Start\r\n${body}`;
  const model = workspace(new Map([[uri, text]]));
  const warnings = () => computeDiagnostics(uri, model).filter(d => d.code === 'SP205')
    .map(d => document(uri, model.documents.getText(uri)!).getText(d.range));
  expect(warnings()).toEqual(['_x', '_y']);
  expect(warnings()).toEqual(['_x', '_y']);
  model.documents.update(uri, text.replace(', _x)', ', 1)').replace('{_y}', 'plain _y'));
  expect(warnings()).toEqual([]);
  model.documents.update(uri, text);
  expect(warnings()).toEqual(['_x', '_y']);
  model.documents.open('file:///macros.js', 'Story.defineMacro({name:"watch",render(){return null;}});');
  expect(warnings()).toEqual(['_y']);
  model.documents.close('file:///macros.js');
  expect(warnings()).toEqual(['_x', '_y']);
});

it('validates a replacement widget macro in StoryInit and invalidates after definition edits (#270)', async () => {
  const definition = ':: Macros [script]\n'
    + 'Story.defineMacro({name:"widget",render(_props,ctx){ctx.mutate(\'$seen = "yes"\');return "custom";}});\n';
  const text = metadata + ':: StoryVariables\n$seen = "no"\n' + definition
    + ':: StoryInit\n{widget "bad"}\n:: Start\n{$seen}';
  const model = workspace(new Map([[uri, text]]));
  model.macros.loadConfig({ widget: { parameters: ['number'] } });
  const errors = () => computeDiagnostics(uri, model).filter(d => d.code === 'SP109');
  expect(errors()).toContainEqual(expect.objectContaining({ message: '{widget}: Argument is not a number', severity: 'error' }));
  const session = await play(new Map([[uri, text]]));
  try {
    const observation = await session.observe();
    expect(observation.errors).toEqual([]);
    expect(observation.text).toBe('yes');
  } finally { await session.close(); }
  model.documents.update(uri, text.replace(definition, ''));
  expect(errors()).toEqual([]);
  model.documents.update(uri, text);
  expect(errors()).toHaveLength(1);
});

it.each(['listbox', 'cycle'])('only applies custom option/else schemas to invocations inside %s (#270)', async control => {
  const definitions = ['option', 'else'].map(name => `Story.defineMacro({name:"${name}",render(){return "replacement";}});`).join('\n');
  const body = `{${control} $choice}{option "yes"}{/${control}}\n{if false}no{else}yes{/if}`;
  const text = metadata + `:: StoryVariables\n$choice = "yes"\n:: Macros [script]\n${definitions}\n:: Start\n${body}`;
  const model = workspace(new Map([[uri, text]]));
  const config = { option: { parameters: ['number'] }, else: { parameters: ['number'] } };
  model.macros.loadConfig(config);
  const errors = () => computeDiagnostics(uri, model).filter(d => d.code === 'SP109');
  expect(errors()).toEqual([]);
  const session = await play(new Map([[uri, text]]));
  try {
    const observation = await session.observe();
    expect(observation.errors).toEqual([]);
    expect(observation.text).toContain('yes');
    expect(observation.actions.find(action => action.type === control)?.options).toEqual(['yes']);
  } finally { await session.close(); }
  const calls = '\n{option "wrong"}{if true}yes{else}no{/if}\n'
    + '{button "{option \'wrong\'}{option \'wrong\'}{if false}no{else}yes{/if}"}Go{/button}';
  model.documents.update(uri, text + calls);
  expect(errors()).toHaveLength(3);
  model.macros.loadConfig({ option: { parameters: ['string'] }, else: { parameters: [] } });
  expect(errors()).toEqual([]);
  model.macros.loadConfig(config);
  expect(errors()).toHaveLength(3);
  // Replacing the parent changes its former option clause into an invocation.
  model.documents.open(extraUri, `:: Controls [widget]\n{widget "${control}" @name}{@children}{/widget}`);
  expect(errors()).toHaveLength(4);
  model.documents.close(extraUri);
  expect(errors()).toHaveLength(3);
});

for (const replacement of ['macro', 'widget']) {
  it(`suppresses the builtin include warning for a ${replacement} replacement (#271)`, async () => {
    const definition = replacement === 'macro'
      ? ':: Macros [script]\nStory.defineMacro({name:"include",parameters:[{name:"target",type:"string",holds:"passage"}],render(_props,ctx){return "NAME:"+ctx.args.target;}});\n'
      : ':: Replacement [widget]\n{widget "include" @target:passage}NAME:{@target}{/widget}\n';
    const text = metadata + ':: StoryVariables\n:: Widgets [widget]\n{widget "greet"}Hello{/widget}\n:: Start\n{include "Widgets"}';
    const model = workspace(new Map([[uri, text], [extraUri, definition]]));
    const includes = () => computeDiagnostics(uri, model).filter(d => d.code === 'SP302');
    expect(includes()).toEqual([]);
    const session = await play(new Map([[uri, text], [extraUri, definition]]));
    try {
      const observation = await session.observe();
      expect(observation.errors).toEqual([]);
      expect(observation.text).toBe('NAME:Widgets');
    } finally { await session.close(); }
    model.documents.update(uri, text.replace('{include "Widgets"}', '{include "Gone"}'));
    expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP300')).toHaveLength(1);
    model.documents.update(uri, text);
    model.documents.update(extraUri, '');
    expect(includes()).toHaveLength(1);
    model.documents.update(extraUri, definition);
    expect(includes()).toEqual([]);
    model.documents.close(extraUri);
    expect(includes()).toHaveLength(1);
  });
}

it.each(['\u2028', '\u2029', '[', '{', '\\', 'x'])('decodes escaped %j in header names/tags like the compiler (#272)', separator => {
  const header = `:: A\\${separator}B [tag\\${separator}tail]`;
  const parsed = parsePassageHeader(header, 3)!;
  const oracle = parseTwee(header).passages[0];
  expect(parsed.name).toBe(oracle.name);
  expect(parsed.tags).toEqual(oracle.tags);
  expect(header.slice(parsed.nameRange.start.character, parsed.nameRange.end.character)).toBe(`A\\${separator}B`);
  expect(parsed.nameRange.start.line).toBe(3);
});

it.each(['\u2028', '\u2029'])('resolves, navigates and renames a destination containing escaped %j (#272)', async separator => {
  const name = `A${separator}B`;
  const text = metadata + `:: StoryVariables\n:: Start\n{link "Go" ${JSON.stringify(name)}}{/link}\n:: A\\${separator}B\nDestination`;
  const model = workspace(new Map([[uri, text]]));
  expect(model.passages.getPassage(name)?.name).toBe(name);
  expect(computeDiagnostics(uri, model).filter(d => d.severity === 'error')).toEqual([]);
  const session = await play(new Map([[uri, text]]));
  try {
    const observation = await session.observe();
    expect(observation.errors).toEqual([]);
    const go = observation.actions.find(action => action.type === 'link')!;
    const next = await session.step(go.id);
    expect(next.errors).toEqual([]);
    expect(next.text).toBe('Destination');
  } finally { await session.close(); }
  const passage = model.passages.getPassage(name)!;
  const edits = computeRename(uri, passage.nameRange.start, 'Room', model).get(uri)!;
  expect(edits).toHaveLength(2);
  const changed = TextDocument.applyEdits(document(uri, text), edits);
  expect(changed).toContain(':: Room\nDestination');
  expect(changed).toContain('{link "Go" "Room"}');
  expect(computeDiagnostics(uri, workspace(new Map([[uri, changed]]))).filter(d => d.severity === 'error')).toEqual([]);
});
