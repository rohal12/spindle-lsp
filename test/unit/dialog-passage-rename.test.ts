import { afterEach, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { documentPassageRefs } from '../../src/core/markup/passage-refs.js';
import { computeRename, prepareRename } from '../../src/plugins/rename.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'file:///story.tw';
let model: WorkspaceModel;
afterEach(() => model?.dispose());

it.each(['widget', 'discovered'])('renames quoted passage parameters of an effective %s named dialog (#289)', kind => {
  const widget = kind === 'widget' ? ':: W [widget]\n{widget "dialog" @target:passage}{@target}{/widget}\n' : '';
  const text = ':: StoryVariables\n:: Old\nHello\n' + widget + ':: Start\n{dialog "Old"}\n{button "{dialog \\"Old\\"}"}Go{/button}';
  model = new WorkspaceModel();
  model.initialize(new Map([[uri, text]]));
  if (kind === 'discovered') model.documents.open('file:///macros.js',
    'Story.defineMacro({name:"dialog",parameters:[{name:"target",type:"string",holds:"passage",required:true}],render(){}});');
  expect(computeDiagnostics(uri, model)).toEqual([]);
  const document = TextDocument.create(uri, 'twee', 0, text);
  const refs = documentPassageRefs(model.markup.get(uri)!);
  expect(refs).toHaveLength(2);
  for (const ref of refs) {
    expect(ref.form).toBe('quoted');
    expect(document.getText(ref.range)).toBe('Old');
    expect(prepareRename(uri, ref.range.start, model)).toEqual({ range: ref.range, placeholder: 'Old' });
  }
  const edits = computeRename(uri, { line: 1, character: 4 }, 'Kitchen', model).get(uri)!;
  expect(edits).toHaveLength(3);
  const output = TextDocument.applyEdits(document, edits);
  expect(output).toBe(text.replaceAll('Old', 'Kitchen'));
  model.documents.update(uri, output);
  expect(documentPassageRefs(model.markup.get(uri)!).map(ref => ref.name)).toEqual(['Kitchen', 'Kitchen']);
  expect(computeDiagnostics(uri, model)).toEqual([]);
});

it('keeps builtin dialog bodies as text even when they start with quotes (#289)', () => {
  const text = ':: StoryVariables\n:: Old\nHello\n:: Start\n{dialog "Title"}"Old"{/dialog}';
  model = new WorkspaceModel();
  model.initialize(new Map([[uri, text]]));
  const [ref] = documentPassageRefs(model.markup.get(uri)!);
  expect(ref.form).toBe('text');
  expect(TextDocument.create(uri, 'twee', 0, text).getText(ref.range)).toBe('"Old"');
  const edits = computeRename(uri, { line: 1, character: 4 }, 'Kitchen', model).get(uri)!;
  const output = TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, text), edits);
  expect(output).toContain('{dialog "Title"}Kitchen{/dialog}');
});
