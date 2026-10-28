import { afterEach, expect, it } from 'vitest';
import { StoryBuilder, startPassageDiagnostics } from '@rohal12/twee-ts';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'file:///story.tw';
const metadata = { ifid: '7E95B777-0E72-4603-AA57-049388D05756', format: 'Spindle' };
const valid = JSON.stringify(metadata);
const models: WorkspaceModel[] = [];
afterEach(() => models.splice(0).forEach(model => model.dispose()));
function workspace(text: string) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text]]));
  return model;
}

it.each([
  `${valid.slice(0, -1)},}`,
  JSON.stringify({ ...metadata, start: 42 }),
  JSON.stringify({ ...metadata, ifid: 'invalid' }),
])('forwards compiler StoryData errors with source ranges and clears them on repair: %s (#200)', data => {
  const errors: import('@rohal12/twee-ts').Diagnostic[] = [];
  const builder = new StoryBuilder();
  builder.add({ name: 'StoryData', tags: [], text: data }, errors);
  expect(errors.filter(d => d.level === 'error').length).toBeGreaterThan(0);
  const text = `:: StoryData\r\n${data}\r\n:: StoryVariables\r\n:: Start\r\nhello`;
  const model = workspace(text);
  const found = computeDiagnostics(uri, model).filter(d => d.code === 'SP003');
  expect(found.map(d => d.message)).toEqual(errors.filter(d => d.level === 'error').map(d => d.message));
  const doc = TextDocument.create(uri, 'twee', 0, text);
  for (const diagnostic of found) {
    expect(diagnostic.severity).toBe('error');
    expect(doc.getText(diagnostic.range)).toBe(data);
  }
  model.documents.update(uri, text.replace(data, valid));
  expect(computeDiagnostics(uri, model)).toEqual([]);
});

it('reports the compiler error for an escaped StoryData header with the old invalid fixture body (#197, #200)', () => {
  const errors: import('@rohal12/twee-ts').Diagnostic[] = [];
  const builder = new StoryBuilder();
  builder.add({ name: 'StoryData', tags: [], text: 'hello' }, errors);
  expect(errors.filter(d => d.level === 'error')).toHaveLength(1);
  const text = ':: StoryVariables\n:: StoryD\\ata\nhello\n';
  const found = computeDiagnostics(uri, workspace(text)).filter(d => d.severity === 'error');
  expect(found).toMatchObject([{ code: 'SP003', message: errors[0].message }]);
  expect(TextDocument.create(uri, 'twee', 1, text).getText(found[0].range)).toBe('hello');
});

it.each(['script', 'stylesheet', 'Twine.private'])('checks explicit and implicit compiler-omitted entries tagged %s (#208)', tag => {
  for (const explicit of [false, true]) {
    const name = explicit ? 'Hidden' : 'Start';
    const data = explicit ? JSON.stringify({ ...metadata, start: 'Hidden' }) : valid;
    const text = `:: StoryData\n${data}\n:: StoryVariables\n:: ${name} [${tag}]\n`;
    const builder = new StoryBuilder();
    builder.add({ name: 'StoryData', tags: [], text: data }, []);
    builder.add({ name, tags: [tag], text: '' }, []);
    const expected = startPassageDiagnostics(builder.build());
    expect(expected).toHaveLength(1);
    const model = workspace(text);
    expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP004').map(d => d.message)).toEqual(expected.map(d => d.message));
    model.documents.update(uri, text.replace(` [${tag}]`, ''));
    expect(computeDiagnostics(uri, model)).toEqual([]);
  }
});

it.each(['StoryData', 'StoryTitle', 'StorySettings'])('checks compiler-owned omission of an explicit %s entry (#208)', name => {
  const data = JSON.stringify({ ...metadata, start: name });
  const text = `:: StoryData\n${data}\n:: StoryTitle\nExample\n:: StorySettings\n:: StoryVariables\n:: Start\nhello`;
  const found = computeDiagnostics(uri, workspace(text)).filter(d => d.code === 'SP004');
  expect(found).toHaveLength(1);
  expect(found[0].message).toContain('left out of the story data');
});

it('tracks effective metadata and entry replacement roles across documents (#200, #208)', () => {
  const model = workspace(`:: StoryData\n${JSON.stringify({ ...metadata, start: 'Hall' })}\n:: StoryVariables\n:: Hall\nhello`);
  const replacement = 'file:///z.tw';
  model.documents.open(replacement, ':: Hall [script]\nvoid 0;');
  expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP004')).toHaveLength(1);
  model.documents.update(replacement, ':: Hall\nhello');
  expect(computeDiagnostics(uri, model)).toEqual([]);
  model.documents.update(replacement, ':: StoryData\n{"ifid":"invalid"}');
  expect(computeDiagnostics(uri, model)).toEqual([]);
  expect(computeDiagnostics(replacement, model).filter(d => d.code === 'SP003')).toHaveLength(1);
  model.documents.close(replacement);
  expect(computeDiagnostics(uri, model)).toEqual([]);
});
