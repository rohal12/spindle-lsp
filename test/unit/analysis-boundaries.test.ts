import { afterEach, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { documentMacroHeads } from '../../src/core/markup/macro-heads.js';
import { computeCodeLenses } from '../../src/plugins/code-lens.js';
import { findVariableReferences, findTransientReferences } from '../../src/plugins/references.js';
import { computeRename } from '../../src/plugins/rename.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'file:///story.tw';
let model: WorkspaceModel;
afterEach(() => model?.dispose());
function workspace(text: string) {
  model = new WorkspaceModel();
  model.initialize(new Map([[uri, text]]));
  return model;
}

it.each(['label', 'attribute'])('collects every head in a large flat %s (#288)', region => {
  const count = 140_000;
  const calls = '{w}'.repeat(count);
  const body = region === 'label' ? `{button "${calls}"}Go{/button}` : `<p title="${calls}">Go</p>`;
  workspace(':: StoryVariables\n:: W [widget]\n{widget "w"}x{/widget}\n:: Start\n' + body);
  const heads = documentMacroHeads(model.markup.get(uri)!).filter(head => head.name === 'w');
  expect(heads).toHaveLength(count);
  expect(heads.every(head => head.invocation && !head.closing)).toBe(true);
  expect(heads.at(-1)!.start - heads[0].start).toBe(3 * (count - 1));
  expect(computeCodeLenses(uri, model).find(lens => lens.range.start.line === 2)?.command.title).toBe(`${count} usages`);
});

it.each(['$', '%'] as const)('retains all repeated %s declarations in references and rename (#292)', sigil => {
  for (const count of [8, 140_000]) {
    const name = sigil === '$' ? 'StoryVariables' : 'StoryTransients';
    const text = `:: ${name}\n` + `${sigil}x = 0\n`.repeat(count) + `:: Start\n{${sigil}x}`;
    workspace(text);
    try {
      const refs = sigil === '$' ? findVariableReferences : findTransientReferences;
      expect(refs('x', model, false)).toHaveLength(1);
      const all = refs('x', model, true);
      expect(all).toHaveLength(count + 1);
      expect(all[0].range.start).toEqual({ line: 1, character: 0 });
      expect(all[count - 1].range.start).toEqual({ line: count, character: 0 });
      for (const position of [{ line: 1, character: 1 }, { line: count + 2, character: 2 }]) {
        const edits = computeRename(uri, position, 'y', model).get(uri)!;
        expect(edits).toHaveLength(count + 1);
        expect(edits.every(edit => edit.newText === 'y')).toBe(true);
        if (count === 8) {
          expect(TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, text), edits)).toBe(text.replaceAll(`${sigil}x`, `${sigil}y`));
        }
      }
    } finally { model.dispose(); }
  }
});

it.each([100, 140_000])('retains structural errors after a flat branch of %i children (#293)', count => {
  workspace(':: StoryVariables\n:: Start\n{switch 1}{case 1}' + '{print 1}'.repeat(count)
    + '{default}d{default}e{/switch}\n{listbox}{/listbox}');
  const diagnostics = computeDiagnostics(uri, model);
  expect(diagnostics.filter(d => d.code === 'SP114')).toMatchObject([
    { message: 'Too many {default} in {switch} (max 1, found 2)', range: { start: { line: 2, character: 0 } } },
  ]);
  expect(diagnostics.filter(d => d.code === 'SP115')).toHaveLength(1);
});
