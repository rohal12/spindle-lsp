import { afterEach, expect, it } from 'vitest';
import { parseTwee } from '@rohal12/twee-ts';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import type { DocumentMarkup } from '../../src/core/markup/passage-markup.js';
import { computeRename } from '../../src/plugins/rename.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'file:///story.tw';
const models: WorkspaceModel[] = [];
afterEach(() => { for (const model of models.splice(0)) model.dispose(); });

function workspace(text: string) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text]]));
  return model;
}

/** Count ownership input reads without prescribing a particular lookup structure. */
function countPassageReads(doc: DocumentMarkup) {
  let reads = 0;
  for (const markup of doc.passages) {
    const passage = markup.passage;
    Object.defineProperty(markup, 'passage', { get() { reads++; return passage; } });
  }
  return () => reads;
}

it.each([256, 512])('bounds passage ownership work for variable rename across %i passages (#315)', count => {
  const text = ':: StoryVariables\n$x = 0\n'
    + Array.from({ length: count }, (_, i) => `:: P${i}\n{$x}\n`).join('');
  const model = workspace(text);
  const reads = countPassageReads(model.markup.get(uri)!);
  for (let request = 0; request < 2; request++) {
    const before = reads();
    const edits = computeRename(uri, { line: 1, character: 1 }, 'renamed', model).get(uri)!;
    expect(edits).toHaveLength(count + 1);
    expect(TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, text), edits))
      .toBe(text.replaceAll('$x', '$renamed'));
    expect(reads() - before).toBeLessThan((count + 1) * 40);
  }
});

it.each([256, 512])('bounds passage ownership work for diagnostics across %i passages (#315)', count => {
  const text = ':: StoryVariables\n$x = 0\n'
    + Array.from({ length: count }, (_, i) => `:: P${i}\n[[go->Missing{$x}]]\n`).join('');
  const model = workspace(text);
  // Exclude the one-time workspace/story analysis from repeated diagnostic requests.
  computeDiagnostics(uri, model);
  const reads = countPassageReads(model.markup.get(uri)!);
  for (let request = 0; request < 2; request++) {
    const before = reads();
    const diagnostics = computeDiagnostics(uri, model).filter(d => d.code === 'SP305');
    expect(diagnostics).toHaveLength(count);
    expect(diagnostics.map(d => d.range.start.line))
      .toEqual(Array.from({ length: count }, (_, i) => i * 2 + 3));
    expect(reads() - before).toBeLessThan((count + 1) * 40);
  }
});

it.each(['\n', '\r\n', '\r'])('retains passage boundaries and binding edits with %j line breaks (#315)', eol => {
  const lines = ['preamble', ':: StoryVariables', '$x = 0', ':: First',
    '{textbox "x"} [[{$x}->Second]]', ':: Second', '{print $x}', ''];
  const text = lines.join(eol);
  const model = workspace(text);
  const doc = model.markup.get(uri)!;
  for (const character of [0, 100]) {
    expect(doc.passageAt({ line: 0, character })).toBeUndefined();
    for (const [line, name] of [[1, 'StoryVariables'], [2, 'StoryVariables'], [3, 'First'],
      [4, 'First'], [5, 'Second'], [6, 'Second'], [7, 'Second'], [100, 'Second']] as const) {
      expect(doc.passageAt({ line, character })?.passage.name).toBe(name);
    }
  }
  const edits = computeRename(uri, { line: 2, character: 1 }, 'renamed', model).get(uri)!;
  expect(edits).toHaveLength(4);
  expect(TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, text), edits))
    .toBe(text.replaceAll('$x', '$renamed').replace('textbox "x"', 'textbox "renamed"'));

  model.documents.update(uri, [':: New', '', ...lines].join(eol));
  const updated = model.markup.get(uri)!;
  expect(updated).not.toBe(doc);
  expect(updated.passageAt({ line: 2, character: 0 })?.passage.name).toBe('New');
  expect(updated.passageAt({ line: 5, character: 0 })?.passage.name).toBe('First');
});

it('handles ownership lookup in a document with no passages (#315)', () => {
  const doc = workspace('').markup.get(uri)!;
  expect(doc.passages).toHaveLength(0);
  expect(doc.passageAt({ line: 0, character: 0 })).toBeUndefined();
});

it.each(['::', ':: ', '::\t', '\uFEFF::', '\uFEFF:: ', '\uFEFF::\t'])
  ('exempts indexed %j headers while retaining prose line-length warnings (#316)', prefix => {
    const name = 'A_long_passage_name';
    const header = `${prefix}${name} [tag] {"position":"100,200"}`;
    const prose = 'This prose line is far too long.';
    const text = `${header}\n${prose}`;
    const compiled = parseTwee(text);
    expect(compiled.passages.map(p => p.name)).toEqual([name]);
    expect(compiled.diagnostics.filter(d => d.level === 'error')).toEqual([]);
    const model = workspace(text);
    const diagnostics = computeDiagnostics(uri, model, { maxLineLength: 10 }).filter(d => d.code === 'SP500');
    expect(diagnostics.map(d => d.range)).toEqual([
      { start: { line: 1, character: 10 }, end: { line: 1, character: prose.length } },
    ]);
  });
