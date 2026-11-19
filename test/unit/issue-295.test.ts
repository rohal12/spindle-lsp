import { afterEach, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeCodeActions } from '../../src/plugins/code-actions.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'file:///a-story.tw';
const oppositeUri = 'file:///b-declarations.tw';
const replacementUri = 'file:///z-declarations.tw';
const models: WorkspaceModel[] = [];
afterEach(() => models.splice(0).forEach(model => model.dispose()));

function workspace(files: Array<[string, string]>) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map(files));
  return model;
}

for (const [sigil, code, target, oppositeSigil, opposite] of [
  ['$', 'SP200', 'StoryVariables', '%', 'StoryTransients'],
  ['%', 'SP203', 'StoryTransients', '$', 'StoryVariables'],
] as const) {
  const story = `:: ${target}\n:: Start\n{print ${sigil}shared}\n`;
  const declaration = `:: ${opposite}\n${oppositeSigil}shared = 1\n`;
  const replacement = `:: ${opposite}\n${oppositeSigil}other = 1\n`;
  function actions(model: WorkspaceModel) {
    const diagnostics = computeDiagnostics(uri, model).filter(d => d.code === code);
    expect(diagnostics).toHaveLength(1);
    return computeCodeActions(uri, diagnostics, model);
  }

  it.each([false, true])(`suppresses ${sigil} declarations colliding with ${opposite} across files=%s (#295)`, separate => {
    const model = workspace(separate
      ? [[uri, story], [oppositeUri, declaration]]
      : [[uri, declaration + story]]);

    expect(actions(model)).toEqual([]);
  });

  it(`tracks effective ${opposite} replacement, live edits and removal for ${sigil} fixes (#295)`, () => {
    const model = workspace([[uri, story], [oppositeUri, declaration], [replacementUri, replacement]]);

    // A superseded declaration must not block a valid fix.
    expect(actions(model)).toHaveLength(1);
    model.documents.update(replacementUri, declaration);
    expect(actions(model)).toEqual([]);
    model.documents.update(replacementUri, replacement);
    expect(actions(model)).toHaveLength(1);
    // Removing the replacement restores the earlier conflicting declaration.
    model.documents.close(replacementUri);
    expect(actions(model)).toEqual([]);
    model.documents.update(oppositeUri, replacement);
    expect(actions(model)).toHaveLength(1);
    model.documents.close(oppositeUri);
    expect(actions(model)).toHaveLength(1);
  });

  it.each([false, true])(`applies noncolliding ${sigil} declaration fixes across files=%s (#295)`, separate => {
    const model = workspace(separate
      ? [[uri, story], [oppositeUri, replacement]]
      : [[uri, replacement + story]]);
    const fixes = actions(model);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].title).toBe(`Declare '${sigil}shared' in ${target}`);
    expect(fixes[0].edits.map(edit => edit.uri)).toEqual([uri]);

    const document = TextDocument.create(uri, 'twee3', 1, model.documents.getText(uri)!);
    const fixed = TextDocument.applyEdits(document, fixes[0].edits);
    expect(fixed).toContain(`${sigil}shared = 0\n`);
    model.documents.update(uri, fixed);
    for (const file of model.documents.getUris()) {
      expect(computeDiagnostics(file, model).filter(d => d.code === code || d.severity === 'error')).toEqual([]);
    }
  });
}
