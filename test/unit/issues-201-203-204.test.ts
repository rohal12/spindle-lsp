import { afterEach, describe, expect, it } from 'vitest';
import { compile } from '@rohal12/twee-ts';
import { fileURLToPath } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'file:///story.tw';
const validData = '"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"';
const models: WorkspaceModel[] = [];
function workspace(text: string, extra: Array<[string, string]> = []) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text], ...extra]));
  return model;
}
afterEach(() => models.splice(0).forEach(model => model.dispose()));

describe('StoryData entry diagnostics (#201)', () => {
  it.each(['{}', '{"start":null}', `{${validData}}`])('allows partial and valid metadata: %s', data => {
    expect(computeDiagnostics(uri, workspace(`:: StoryData\n${data}\n:: StoryVariables\n:: Start\nhello`))).toEqual([]);
  });

  it.each(['"start":"Hall"', '"Start":"Hall"', String.raw`"St\u0061rt":"Hall"`, '"start":"Gone","START":"Hall"', '"start":"Hall","start":null'])('checks the compiler-effective explicit entry: %s', async field => {
    const text = `:: StoryTitle\nExample\n:: StoryData\n{${validData},${field}}\n:: StoryVariables\n:: Start\nhello`;
    const compiled = await compile({
      sources: [{ filename: uri, content: text }],
      formatId: 'pkg',
      formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
      noRemote: true, useTweegoPath: false,
    });
    const errors = compiled.diagnostics.filter(d => d.level === 'error');
    expect(errors).toHaveLength(1);
    const model = workspace(text);
    const found = computeDiagnostics(uri, model).filter(d => d.code === 'SP004');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', message: errors[0].message });
    expect(TextDocument.create(uri, 'twee', 0, text).getText(found[0].range)).toBe('StoryData');
    const targetUri = 'file:///target.tw';
    model.documents.open(targetUri, ':: Hall\nhello');
    expect(computeDiagnostics(uri, model)).toEqual([]);
    model.documents.update(targetUri, ':: Other\nhello');
    expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP004')).toHaveLength(1);
    model.documents.update(targetUri, ':: Hall\nhello');
    expect(computeDiagnostics(uri, model)).toEqual([]);
    model.documents.close(targetUri);
    expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP004')).toHaveLength(1);
  });

  it('uses the last StoryData replacement, including metadata that clears an earlier entry', () => {
    const text = `:: StoryData\n{${validData},"start":"Gone"}\n:: StoryVariables\n:: Start\nhello`;
    const replacement = 'file:///z.tw';
    const model = workspace(text, [[replacement, ':: StoryData\n{}']]);
    expect(computeDiagnostics(uri, model)).toEqual([]);
    expect(computeDiagnostics(replacement, model)).toEqual([]);
    model.documents.update(replacement, ':: StoryData\n{"start":"Elsewhere"}');
    expect(computeDiagnostics(uri, model)).toEqual([]);
    expect(computeDiagnostics(replacement, model).filter(d => d.code === 'SP004')).toHaveLength(1);
    model.documents.update(replacement, ':: StoryData\n{"start":"Start"}');
    expect(computeDiagnostics(replacement, model)).toEqual([]);
  });
});

describe.each(['\n', '\r\n'])('SP205 source ranges with EOL %j (#203, #204)', eol => {
  const astral = '😀'.repeat(100);
  const assignments = [
    '{set "ascii", _x = @i}',
    `{set "${astral}", _x = @i}`,
    `{set /${astral}/, _x = @i}`,
    `{set /*${astral}\ncomment*/ _x = @i}`,
    '{set "a", _x=@i}',
    '{computed _x = @i}',
  ];
  for (const depth of [0, 1, 2]) {
    it.each(assignments)(`underlines the assigned variable at label depth ${depth}: %s`, assignment => {
      let body = `{for @i of [1,2]}${assignment}{_x}{/for}`;
      for (let i = 0; i < depth; i++) body = `{button ${JSON.stringify(body)}}x{/button}`;
      const text = `:: StoryVariables\n:: Start\n${body}`.replaceAll('\n', eol);
      const found = computeDiagnostics(uri, workspace(text)).filter(d => d.code === 'SP205');
      expect(found).toHaveLength(1);
      const doc = TextDocument.create(uri, 'twee', 0, text);
      expect(doc.getText(found[0].range)).toBe('_x');
      expect(found[0].range.start).toEqual(doc.positionAt(text.indexOf('_x')));
    });
  }
});
