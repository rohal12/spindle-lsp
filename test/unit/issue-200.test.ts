import { afterEach, expect, it } from 'vitest';
import { parseTwee, StoryBuilder, type Diagnostic } from '@rohal12/twee-ts';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const first = 'file:///a.tw';
const last = 'file:///z.tw';
const metadata = { ifid: '7E95B777-0E72-4603-AA57-049388D05756', format: 'Spindle' };
const valid = JSON.stringify(metadata);
const opening = ':: StoryTitle\nExample\n:: StoryVariables\n:: Start\nHello\n';
const models: WorkspaceModel[] = [];
afterEach(() => models.splice(0).forEach(model => model.dispose()));

function workspace(contents: Map<string, string>) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(contents);
  return model;
}

/** The compiler decodes every source declaration before replacing metadata. */
function compilerErrors(contents: Map<string, string>): string[] {
  const builder = new StoryBuilder();
  const diagnostics: Diagnostic[] = [];
  for (const uri of [...contents.keys()].sort()) {
    for (const passage of parseTwee(contents.get(uri)!).passages) builder.add(passage, diagnostics);
  }
  return diagnostics.filter(d => d.level === 'error').map(d => d.message);
}

for (const separate of [false, true]) {
  for (const eol of ['\n', '\r\n']) {
    it.each([
      '{"format":"Spindle",}',
      JSON.stringify({ ...metadata, start: 42 }),
      JSON.stringify({ ...metadata, ifid: 'invalid' }),
    ])(`reports superseded StoryData errors (separate=${separate}, EOL=${eol.length}): %s`, data => {
      const earlier = `${opening}:: StoryData\n${data}\n`;
      const replacement = `:: StoryData\n${valid}\n`;
      const contents = separate
        ? new Map([[last, replacement.replaceAll('\n', eol)], [first, earlier.replaceAll('\n', eol)]])
        : new Map([[first, (earlier + replacement).replaceAll('\n', eol)]]);
      const expected = compilerErrors(contents);
      expect(expected).toHaveLength(1);
      const model = workspace(contents);
      const found = computeDiagnostics(first, model).filter(d => d.code === 'SP003');
      expect(found.map(d => d.message)).toEqual(expected);
      const doc = TextDocument.create(first, 'twee', 0, contents.get(first)!);
      expect(doc.getText(found[0].range)).toBe(data);
      expect(found[0].severity).toBe('error');
      if (separate) expect(computeDiagnostics(last, model)).toEqual([]);

      model.documents.update(first, contents.get(first)!.replace(data, valid));
      expect(computeDiagnostics(first, model)).toEqual([]);
      expect(model.storyFormat).toBe('Spindle');
    });
  }
}

it('retains errors from every StoryData in one document, including the effective declaration', () => {
  const one = '{"format":"Spindle","start":42}';
  const two = '{"format":"Spindle","ifid":"invalid"}';
  const text = `${opening}:: StoryData\n${one}\n:: StoryData\n${two}\n:: StoryData\n${valid.slice(0, -1)},}\n`;
  const contents = new Map([[first, text]]);
  const expected = compilerErrors(contents);
  expect(expected).toHaveLength(3);
  const model = workspace(contents);
  const found = computeDiagnostics(first, model).filter(d => d.code === 'SP003');
  expect(found.map(d => d.message)).toEqual(expected);
  const doc = TextDocument.create(first, 'twee', 0, text);
  expect(found.map(d => doc.getText(d.range))).toEqual([one, two, `${valid.slice(0, -1)},}`]);
});

it('keeps effective format, version and entry selection when validating all metadata sources', () => {
  const earlier = JSON.stringify({ ...metadata, format: 'SugarCube', 'format-version': '0.1.0', start: 'Gone' });
  const text = `${opening}:: StoryData\n${earlier}\n`;
  const replacement = `:: StoryData\n${JSON.stringify({ ...metadata, 'format-version': '0.64.24' })}\n`;
  const model = workspace(new Map([[last, replacement], [first, text]]));
  expect(compilerErrors(new Map([[first, text], [last, replacement]]))).toEqual([]);
  expect(computeDiagnostics(first, model)).toEqual([]);
  expect(computeDiagnostics(last, model)).toEqual([]);
  expect(model.storyFormat).toBe('Spindle');
  expect(model.target).toMatchObject({ version: '0.64.24', supported: true });

  model.documents.update(last, ':: StoryData\n{}\n');
  expect(model.storyFormat).toBeUndefined();
  expect(computeDiagnostics(first, model)).toEqual([]);
  expect(computeDiagnostics(last, model)).toEqual([]);
  model.documents.close(last);
  expect(model.storyFormat).toBe('SugarCube');
  expect(model.isSpindleProject()).toBe(false);
});

it('places entry errors on the final metadata while preserving superseded decoding errors', () => {
  const contents = new Map([
    [first, `${opening}:: StoryData\n{"start":42}\n`],
    [last, ':: StoryData\n{"start":"Gone"}\n'],
  ]);
  const model = workspace(contents);
  expect(computeDiagnostics(first, model).map(d => d.code)).toEqual(['SP003']);
  expect(computeDiagnostics(last, model).map(d => d.code)).toEqual(['SP004']);
  model.documents.open('file:///entry.tw', ':: Gone\nHello');
  expect(computeDiagnostics(last, model)).toEqual([]);
  expect(computeDiagnostics(first, model).map(d => d.message)).toEqual(compilerErrors(contents));
});
