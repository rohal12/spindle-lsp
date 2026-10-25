import { afterEach, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { StoryBuilder, compile } from '@rohal12/twee-ts';
import { openPlaySession } from '@rohal12/spindle/play';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeRename } from '../../src/plugins/rename.js';
import { readStoryDataFormat, storyDataFormatVersion } from '../../src/core/workspace/story-format.js';

const uri = 'file:///story.tw';
const models: WorkspaceModel[] = [];
function workspace(text: string) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text]]));
  return model;
}
afterEach(() => models.splice(0).forEach(model => model.dispose()));

it.each([
  ['{"Format":"SugarCube"}', 'SugarCube'],
  [String.raw`{"For\u006dat":"SugarCube"}`, 'SugarCube'],
  ['{"format":"Spindle","FORMAT":"SugarCube"}', 'SugarCube'],
  ['{"FORMAT":"SugarCube","format":"Spindle"}', 'Spindle'],
  ['{"format":"SugarCube","format":null}', 'SugarCube'],
  ['{"Format":"SugarCube","format":null}', 'SugarCube'],
  ['{"format":"SugarCube","format":3}', 'SugarCube'],
  ['{"format":null,"Format":"SugarCube"}', 'SugarCube'],
])('uses compiler format semantics for %s (#185)', (data, expected) => {
  const builder = new StoryBuilder();
  builder.add({ name: 'StoryData', tags: [], text: data }, []);
  expect(builder.build().twine2.format).toBe(expected);
  expect(readStoryDataFormat(data)).toBe(expected);
  const model = workspace(`:: StoryData\n${data}\n:: Start\nHello`);
  expect(model.storyFormat).toBe(expected);
  expect(model.isSpindleProject()).toBe(expected === 'Spindle');
});

it.each([
  ['{"Format":"Spindle","FORMAT-VERSION":"0.59.0"}', '0.59.0'],
  [String.raw`{"format":"Spindle","format-\u0076ersion":"0.59.0"}`, '0.59.0'],
  ['{"format":"Spindle","format-version":"0.59.0","format-version":null}', '0.59.0'],
  ['{"Format":"SugarCube","FORMAT-VERSION":"0.59.0"}', undefined],
])('uses compiler version semantics for %s (#185)', (data, version) => {
  const text = `:: StoryData\n${data}\n:: Start\nHello`;
  const model = workspace(text);
  expect(storyDataFormatVersion(model.passages.getAllPassages(), () => text)).toBe(version);
  if (version) expect(model.target).toMatchObject({ version, source: 'story-data', supported: false });
});

for (const eol of ['\n', '\r\n']) {
  it.each([
    '"Start":"Hall"',
    '"START":"Hall"',
    String.raw`"St\u0061rt":"Hall"`,
    '"ſtart":"Hall"',
    '"start":"Other","Start":"Hall"',
    '"Start":"Other","start":"Hall"',
    '"start":null,"start":"Hall"',
  ])(`preserves the compiled entry and source keys for %s (EOL ${eol.length}, #185)`, async field => {
    const data = `{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle",${field},"nested":{"Start":"Hall"}}`;
    const text = `:: StoryTitle\nExample\n:: StoryData\n${data}\n:: StoryVariables\n:: Hall\nHello.\n:: Other\nOther.`.replaceAll('\n', eol);
    const model = workspace(text);
    const doc = TextDocument.create(uri, 'twee', 0, text);
    const edits = computeRename(uri, doc.positionAt(text.indexOf(':: Hall') + 4), 'A "quote"', model);
    const changed = TextDocument.applyEdits(doc, edits.get(uri)!);
    const expectedField = field.replaceAll('"Hall"', '"A \\"quote\\""').replaceAll('"Other"', '"A \\"quote\\""');
    expect(changed).toContain(expectedField);
    expect(changed).toContain('"nested":{"Start":"Hall"}');
    expect(changed.replaceAll(eol, '')).not.toMatch(/[\r\n]/);
    const compiled = await compile({
      sources: [{ filename: uri, content: changed }],
      formatId: 'pkg',
      formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
      noRemote: true,
      useTweegoPath: false,
    });
    expect(compiled.diagnostics.filter(d => d.level === 'error')).toEqual([]);
    expect(compiled.story.twine2.start).toBe('A "quote"');
    const session = await openPlaySession({ html: compiled.output, trusted: true });
    try {
      expect(await session.observe()).toMatchObject({ passage: 'A "quote"', text: 'Hello.', errors: [] });
    } finally { await session.close(); }
  });
}

it.each(['"Start":"Hall","start":null', '"START":null,"Start":"Hall"', '"Start":"Hall","start":3'])('rejects unsafe source entry fields atomically: %s (#185)', field => {
  const text = `:: StoryData\n{${field}}\n:: Hall\nHello`;
  const model = workspace(text);
  expect(() => computeRename(uri, { line: 2, character: 4 }, 'Opening', model)).toThrow(/Cannot preserve the entry passage/);
  expect(model.documents.getText(uri)).toBe(text);
});

it.each(['"Start":"Hall"', '"start":"Hall","start":null'])('keeps the compiler entry when renaming a non-entry Start: %s (#185)', field => {
  const text = `:: StoryData\n{${field}}\n:: Start\nOther\n:: Hall\nHello`;
  const model = workspace(text);
  const doc = TextDocument.create(uri, 'twee', 0, text);
  const edits = computeRename(uri, { line: 2, character: 4 }, 'Opening', model);
  const changed = TextDocument.applyEdits(doc, edits.get(uri)!);
  expect(changed).toBe(text.replace(':: Start', ':: Opening'));
  const builder = new StoryBuilder();
  builder.add({ name: 'StoryData', tags: [], text: changed.split('\n')[1] }, []);
  expect(builder.build().twine2.start).toBe('Hall');
});
