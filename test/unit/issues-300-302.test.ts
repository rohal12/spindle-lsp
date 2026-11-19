import { afterEach, expect, it, vi } from 'vitest';
import type { Connection } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { passagePieces } from '@rohal12/spindle/tooling';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { documentPassageRefs } from '../../src/core/markup/passage-refs.js';
import { computeRename } from '../../src/plugins/rename.js';
import { computeCodeLenses } from '../../src/plugins/code-lens.js';
import { computeDiagnostics, diagnosticsPlugin } from '../../src/plugins/diagnostics.js';

const uri = 'file:///story.tw';
const models: WorkspaceModel[] = [];
function workspace(files: Map<string, string>) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(files);
  return model;
}
afterEach(() => {
  for (const model of models.splice(0)) model.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([128, 256])('bounds passage rename ownership work for %i flat and nested references (#300)', count => {
  for (const body of [
    '{goto "Target"}',
    '{button ' + JSON.stringify('say {goto "Target"}') + '}x{/button}',
    '{button ' + JSON.stringify('{button ' + JSON.stringify('deep {goto "Target"}') + '}x{/button}') + '}x{/button}',
    `<span title='{goto "Target"}'>x</span>`,
  ]) {
    const text = ':: StoryVariables\n:: Target\nHi\n:: Start\n' + (body + '\n').repeat(count);
    const model = workspace(new Map([[uri, text]]));
    const doc = model.markup.get(uri)!;
    expect(documentPassageRefs(doc).map(ref => ref.name)).toEqual(Array(count).fill('Target'));
    const passage = doc.passages.at(-1)!;
    let reads = 0;
    const pieces = passage.pieces.map(piece => new Proxy(piece, {
      get(target, key, receiver) {
        if (key === 'offset' || key === 'kind') reads++;
        return Reflect.get(target, key, receiver);
      },
    }));
    Object.defineProperty(passage, 'pieces', { value: pieces });
    const name = 'Next \\ route';
    for (let request = 0; request < 2; request++) {
      const edits = computeRename(uri, { line: 1, character: 4 }, name, model).get(uri)!;
      expect(edits).toHaveLength(count + 1);
      const output = TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, text), edits);
      // Read the applied body with the runtime's public tooling API.
      const refs = passagePieces(output.slice(output.indexOf(':: Start\n') + 9), doc.context.macros)
        .filter(piece => piece.kind === 'passage');
      expect(refs.map(ref => ref.name)).toEqual(Array(count).fill(name));
    }
    expect(reads).toBeLessThan(pieces.length * 20 + count * 20);
  }
});

it.each([64, 128])('enumerates %i documents once per code-lens request, with live reference changes (#301)', count => {
  const files = new Map([[uri, Array.from({ length: count }, (_, i) => `:: P${i}\n[[P${i}]]\n`).join('')]]);
  for (let i = 0; i < count; i++) files.set(`file:///q${i}.tw`, `:: Q${i}\n[[P${i}]] {goto "P${i}"}`);
  const duplicate = 'file:///duplicate.tw';
  files.set(duplicate, ':: P0\n[[P0]]');
  const model = workspace(files);
  computeCodeLenses(uri, model);
  const get = vi.spyOn(model.markup, 'get');
  const enumerate = vi.spyOn(model.documents, 'getUris');
  const lenses = computeCodeLenses(uri, model);
  expect(lenses.map(lens => lens.command.title)).toEqual(['4 references', ...Array(count - 1).fill('3 references')]);
  expect(get.mock.calls.length).toBeLessThanOrEqual(files.size + 1);
  expect(enumerate).toHaveBeenCalledTimes(1);
  expect(computeCodeLenses(duplicate, model)[0].command.title).toBe('4 references');
  model.documents.update('file:///q0.tw', ':: Q0\n[[P1]]');
  expect(computeCodeLenses(uri, model).slice(0, 2).map(lens => lens.command.title)).toEqual(['2 references', '4 references']);
  model.documents.close(duplicate);
  expect(computeCodeLenses(uri, model)[0].command.title).toBe('1 reference');
  model.documents.open('file:///q0.tw', ':: Q0\n[[P0]]');
  expect(computeCodeLenses(uri, model).slice(0, 2).map(lens => lens.command.title)).toEqual(['2 references', '3 references']);
});

it.each([64, 128])('shares diagnostic work across cold and warm publications of %i files (#302)', count => {
  vi.useFakeTimers();
  const files = new Map([[uri, ':: StoryVariables\n']]);
  for (let i = 0; i < count; i++) files.set(`file:///p${i}.tw`, `:: P${i}\nHi\n`);
  const model = workspace(files);
  const get = vi.spyOn(model.markup, 'get');
  const effective = vi.spyOn(model.passages, 'getEffectivePassages');
  const all = vi.spyOn(model.passages, 'getAllPassages');
  const enumerate = vi.spyOn(model.passages, 'getDocumentUris');
  const sendDiagnostics = vi.fn();
  diagnosticsPlugin.initialize({ workspace: model, config: {}, connection: { sendDiagnostics } as unknown as Connection });
  for (let publication = 0; publication < 2; publication++) {
    model.emit('modelReady');
    expect(sendDiagnostics).toHaveBeenCalledTimes(files.size);
    expect(sendDiagnostics.mock.calls.every(([params]) => params.diagnostics.length === 0)).toBe(true);
    expect(get.mock.calls.length).toBeLessThanOrEqual(files.size * 3);
    expect(effective.mock.calls.length).toBeLessThanOrEqual(1);
    expect(all.mock.calls.length).toBeLessThanOrEqual(8);
    expect(enumerate.mock.calls.length).toBeLessThanOrEqual(2);
    vi.clearAllMocks();
  }
  // The CLI and MCP also call the single-document API in a loop.
  for (const file of files.keys()) expect(computeDiagnostics(file, model)).toEqual([]);
  expect(get).toHaveBeenCalledTimes(files.size);
  expect(effective).not.toHaveBeenCalled();
  expect(all).not.toHaveBeenCalled();
  expect(enumerate).not.toHaveBeenCalled();
  vi.clearAllMocks();
  model.documents.update('file:///p0.tw', ':: P0\nHi!\n');
  vi.advanceTimersByTime(200);
  expect(sendDiagnostics).toHaveBeenCalledTimes(files.size);
  expect(get.mock.calls.length).toBeLessThan(files.size * 12);
  expect(effective.mock.calls.length).toBeLessThan(12);
});

it('refreshes shared diagnostic state for replacements, removals, declarations and macro config (#302)', () => {
  const target = 'file:///z.tw';
  const model = workspace(new Map([
    [uri, ':: StoryVariables\n$x = 1\n:: Start\n[[Target]] {$x} {local "ok"}'],
    [target, ':: Target\nHi'],
  ]));
  const codes = (file = uri) => computeDiagnostics(file, model).map(d => d.code);
  expect(codes()).toContain('SP100');
  expect(codes()).not.toContain('SP300');
  model.macros.loadConfig({ local: {} });
  expect(codes()).not.toContain('SP100');
  model.documents.update(target, ':: Other\nHi');
  expect(codes()).toContain('SP300');
  model.documents.open(target, ':: Target\nHi');
  expect(codes()).not.toContain('SP300');
  const replacement = 'file:///zz.tw';
  model.documents.open(replacement, ':: Start [replace]\n{missing}');
  expect(codes()).toEqual([]);
  expect(codes(replacement)).toContain('SP100');
  model.documents.close(replacement);
  expect(codes()).toEqual([]);
  model.documents.close(target);
  expect(codes()).toContain('SP300');
  model.documents.update(uri, ':: Start\n{$x}');
  expect(codes()).toContain('SP202');
  const variables = 'file:///a.tw';
  model.documents.open(variables, ':: StoryVariables\n$x = 1');
  expect(codes()).not.toContain('SP202');
  expect(codes()).not.toContain('SP200');
  model.documents.update(variables, ':: StoryVariables\n$x = ');
  expect(codes(variables)).toContain('SP207');
  model.documents.close(variables);
  expect(codes()).toContain('SP202');
});
