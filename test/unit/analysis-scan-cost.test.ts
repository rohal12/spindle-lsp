import { afterEach, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { documentPassageRefs } from '../../src/core/markup/passage-refs.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'file:///story.tw';
let model: WorkspaceModel;
afterEach(() => model?.dispose());

it.each([64, 128])('bounds dialog metadata reads across %i passages with many widgets (#289)', count => {
  model = new WorkspaceModel();
  const widgets = Array.from({ length: count }, (_, i) => `{widget "w${i}"}x{/widget}`).join('');
  const override = '{widget "dialog" @target:passage}{@target}{/widget}';
  const passages = Array.from({ length: count }, (_, i) => `:: P${i}\n{dialog "P0"}\n`).join('');
  const text = ':: StoryVariables\n:: Widgets [widget]\n' + widgets + override + '\n' + passages;
  model.initialize(new Map([[uri, text]]));
  const doc = model.markup.get(uri)!;
  const macros = doc.context.macros;
  let reads = 0;
  Object.defineProperty(doc.context, 'macros', {
    value: new Proxy(macros, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    }),
  });
  const refs = documentPassageRefs(doc);
  expect(refs).toHaveLength(count);
  expect(refs.every(ref => ref.name === 'P0' && ref.form === 'quoted')).toBe(true);
  expect(reads).toBeLessThanOrEqual(macros.length * 2);

  model.documents.update(uri, text.replace(override, '').replaceAll('{dialog "P0"}', '{dialog "Title"}"P0"{/dialog}'));
  const builtinRefs = documentPassageRefs(model.markup.get(uri)!);
  expect(builtinRefs).toHaveLength(count);
  expect(builtinRefs.every(ref => ref.name === 'P0' && ref.form === 'text')).toBe(true);
});

it.each([64, 128])('bounds decoded-offset reads for %i escaped nested targets after edits (#287)', count => {
  model = new WorkspaceModel();
  const original = ':: StoryVariables\r\n:: Target\r\nHi\r\n:: Start\r\n{link "'
    + '{goto \\"Target\\"}'.repeat(count) + '" "Target"}Go{/link}';
  model.initialize(new Map([[uri, original]]));
  for (const text of [original, original.replaceAll('Target', 'Next')]) {
    model.documents.update(uri, text);
    const doc = model.markup.get(uri)!;
    let reads = 0;
    let boundaries = 0;
    for (const passage of doc.passages) for (const piece of passage.pieces) {
      if (piece.kind !== 'text' || !piece.sourceOffsets) continue;
      boundaries += piece.sourceOffsets.length;
      piece.sourceOffsets = new Proxy(piece.sourceOffsets, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
          return Reflect.get(target, key, receiver);
        },
      });
    }
    expect(boundaries).toBeGreaterThan(count);
    const refs = documentPassageRefs(doc);
    expect(refs).toHaveLength(count + 1);
    const document = TextDocument.create(uri, 'twee', 0, text);
    expect(refs.every(ref => ref.form === 'quoted' && document.getText(ref.range) === ref.name)).toBe(true);
    expect(reads).toBeLessThan(boundaries * 8);
    expect(computeDiagnostics(uri, model)).toEqual([]);
  }
});

it.each([64, 128])('bounds passage enumeration for %i repeated includes on warm diagnostics (#290)', count => {
  model = new WorkspaceModel();
  model.initialize(new Map([[uri, ':: StoryVariables\n:: Target\nHi\n'
    + Array.from({ length: count }, (_, i) => `:: P${i}\nHi\n`).join('')
    + ':: Start\n' + '{include "Target"}'.repeat(count)]]));
  expect(computeDiagnostics(uri, model)).toEqual([]);
  const passages = model.passages.getPassagesInDocument(uri);
  let visits = 0;
  Object.defineProperty(passages, Symbol.iterator, {
    value: function* () {
      for (let i = 0; i < passages.length; i++) { visits++; yield passages[i]; }
    },
  });
  expect(computeDiagnostics(uri, model)).toEqual([]);
  expect(visits).toBeLessThanOrEqual(passages.length * 10);
});

it('refreshes include destination roles and builtin ownership (#290)', () => {
  model = new WorkspaceModel();
  model.initialize(new Map([[uri, ':: StoryVariables\n:: W [widget]\n{widget "w"}Hi{/widget}\n:: Start\n{include "W"}']]));
  const includes = () => computeDiagnostics(uri, model).filter(d => d.code === 'SP302');
  expect(includes()).toHaveLength(1);
  model.documents.open('file:///z.tw', ':: W\nordinary passage');
  expect(includes()).toHaveLength(0);
  model.documents.close('file:///z.tw');
  expect(includes()).toHaveLength(1);
  model.documents.open('file:///macros.js', 'Story.defineMacro({name:"include",parameters:[{name:"target",type:"string",holds:"passage"}]});');
  expect(includes()).toHaveLength(0);
});
