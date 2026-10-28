import { afterEach, expect, it } from 'vitest';
import { compile } from '@rohal12/twee-ts';
import { openPlaySession } from '@rohal12/spindle/play';
import { fileURLToPath } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeRename, prepareRename } from '../../src/plugins/rename.js';
import { findReferences, findWidgetReferences } from '../../src/plugins/references.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { getCompletions } from '../../src/plugins/completions.js';

const uri = 'file:///story.tw';
const metadata = ':: StoryTitle\nExample\n:: StoryData\n'
  + '{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"}\n';
const models: WorkspaceModel[] = [];
afterEach(() => models.splice(0).forEach(model => model.dispose()));
function workspace(text: string) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text]]));
  return model;
}
async function play(text: string) {
  const result = await compile({
    sources: [{ filename: uri, content: text }], formatId: 'pkg',
    formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
    noRemote: true, useTweegoPath: false,
  });
  expect(result.diagnostics.filter(d => d.level === 'error')).toEqual([]);
  return openPlaySession({ html: result.output, trusted: true });
}

it.each(['listbox', 'cycle'])('preserves parent-owned %s options when renaming the option widget (#206)', async control => {
  const text = metadata + ':: StoryVariables\n$x = "A"\n:: W [widget]\n'
    + '{widget "option" @value}Widget:{@value}{/widget}\n:: Start\n{option "standalone"}\n'
    + `{${control} "$x"}{option "A"}{OpTiOn "B"}{/${control}}`;
  const model = workspace(text);
  const doc = TextDocument.create(uri, 'twee', 1, text);
  const choice = doc.positionAt(text.indexOf('{option "A"}') + 2);
  expect(prepareRename(uri, choice, model)).toBeNull();
  expect(computeRename(uri, choice, 'choose', model).size).toBe(0);
  expect(findReferences(uri, choice, model, true)).toEqual([]);
  expect(getDefinition(uri, choice, model)).toBeNull();
  expect(findWidgetReferences('option', model, false)).toHaveLength(1);
  const definition = model.widgets.getWidget('option')!;
  const call = doc.positionAt(text.indexOf('{option "standalone"}') + 2);
  expect(prepareRename(uri, call, model)?.placeholder).toBe('option');
  const edits = computeRename(uri, definition.nameRange.start, 'choose', model).get(uri)!;
  expect(computeRename(uri, call, 'choose', model).get(uri)).toEqual(edits);
  expect(edits).toHaveLength(2);
  const renamed = TextDocument.applyEdits(doc, edits);
  expect(renamed).toContain(`{${control} "$x"}{option "A"}{OpTiOn "B"}{/${control}}`);
  expect(renamed).toContain('{choose "standalone"}');
  for (const source of [text, renamed]) {
    const session = await play(source);
    try {
      const observation = await session.observe();
      expect(observation.errors).toEqual([]);
      expect(observation.text).toContain('Widget:standalone');
      expect(observation.actions.find(action => action.type === control)?.options).toEqual(['A', 'B']);
    } finally { await session.close(); }
  }
});

it('retains genuine nested, label and attribute calls and respects replacement controls (#206)', () => {
  const text = metadata + ':: StoryVariables\n$x = "A"\n:: W [widget]\n'
    + '{widget "option" @value}Widget:{@value}{/widget}\n:: Start\n'
    + '{listbox "$x"}{option "A"}<span>{option "nested"}</span>{/listbox}\n'
    + '<span title="{option \'attribute\'}">x</span>\n{button "{option \'label\'}"}x{/button}';
  const model = workspace(text);
  expect(findWidgetReferences('option', model, false)).toHaveLength(3);
  const extra = 'file:///z.tw';
  model.documents.open(extra, ':: Controls [widget]\n{widget "listbox" @name}{@children}{/widget}');
  expect(findWidgetReferences('option', model, false)).toHaveLength(4);
  model.documents.close(extra);
  expect(findWidgetReferences('option', model, false)).toHaveLength(3);
});

it.each(['\n', '\r\n'])('preserves registration syntax for a widget named widget (EOL %j, #229)', async eol => {
  const text = (metadata + ':: StoryVariables\n:: W [widget]\n'
    + '{widget "widget" @value}Output:{@value}:{@children}{/widget}\n'
    + '{widget "other"}Other{/widget}\n:: Start\n{widget "hello"}Body{/widget}').replaceAll('\n', eol);
  const model = workspace(text);
  expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP301')).toEqual([]);
  const doc = TextDocument.create(uri, 'twee', 1, text);
  const registration = doc.positionAt(text.indexOf('{widget "other"}') + 2);
  expect(prepareRename(uri, registration, model)).toBeNull();
  expect(findReferences(uri, registration, model, false)).toEqual([]);
  expect(findWidgetReferences('widget', model, false, false)).toHaveLength(1);
  expect(findWidgetReferences('widget', model, false)).toHaveLength(2);
  const edits = computeRename(uri, model.widgets.getWidget('widget')!.nameRange.start, 'renamed', model).get(uri)!;
  expect(edits).toHaveLength(3);
  const renamed = TextDocument.applyEdits(doc, edits);
  expect(renamed).toContain('{widget "renamed" @value}Output:{@value}:{@children}{/widget}');
  expect(renamed).toContain('{widget "other"}Other{/widget}');
  expect(renamed).toContain('{renamed "hello"}Body{/renamed}');
  for (const source of [text, renamed]) {
    const session = await play(source);
    try {
      const observation = await session.observe();
      expect(observation.errors).toEqual([]);
      expect(observation.text).toContain('Output:hello:');
      expect(observation.text).toContain('Body');
    } finally { await session.close(); }
  }
  model.documents.update(uri, text.slice(0, text.indexOf(':: Start')) + ':: Start\nNo calls');
  expect(model.widgets.isInvoked('widget')).toBe(false);
  expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP303').map(d => d.message)).toContain('Widget "widget" is defined but never invoked in the workspace');
});

it('offers navigable bracket destinations while retaining special passages for includes (#202)', async () => {
  const text = metadata + ':: StoryVariables\n:: StoryInit\n:: Start\n[[Ha]]\n:: Hall\nNormal';
  const model = workspace(text);
  const doc = TextDocument.create(uri, 'twee', 1, text);
  const position = doc.positionAt(text.indexOf('[[Ha]]') + 4);
  const items = getCompletions(uri, position, undefined, model);
  expect(items.map(item => item.label)).toContain('Hall');
  expect(items.map(item => item.label)).not.toContain('StoryInit');
  expect(items.map(item => item.label)).not.toContain('StoryVariables');
  const item = items.find(item => item.label === 'Hall')!;
  const applied = TextDocument.applyEdits(doc, [{
    range: { start: doc.positionAt(text.indexOf('[[Ha]]') + 2), end: position },
    newText: item.insertText ?? item.label,
  }]);
  const session = await play(applied);
  try {
    const observation = await session.observe();
    const action = observation.actions.find(action => action.type === 'link')!;
    const next = await session.step(action.id);
    expect(next.passage).toBe('Hall');
    expect(next.errors).toEqual([]);
  } finally { await session.close(); }
  model.documents.update(uri, applied.replace('[[Hall]]', '{include "StoryInit"}'));
  expect(computeDiagnostics(uri, model).filter(d => d.severity === 'error')).toEqual([]);
});
