import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { deepTokens } from '../helpers/tooling.js';

const uri = 'file:///story.tw';
let workspace: WorkspaceModel;
afterEach(() => { vi.restoreAllMocks(); workspace?.dispose(); });

it.each([
  [64, 'nosuch', 64], [128, 'nosuch', 128], [128, 'print 1', 0],
] as const)('bounds token visits for %i repeated {%s} calls (#253)', (count, macro, errors) => {
  workspace = new WorkspaceModel();
  workspace.initialize(new Map([[uri, ':: StoryVariables\n:: Start\n' + `{${macro}}\n`.repeat(count)]]));
  computeDiagnostics(uri, workspace); // Warm the tooling report and passage analyses.
  const tokens = workspace.markup.get(uri)!.passages[1].tokens;
  let visits = 0;
  Object.defineProperty(tokens, Symbol.iterator, {
    value: function* () {
      for (let i = 0; i < tokens.length; i++) {
        visits++;
        yield tokens[i];
      }
    },
  });
  const diagnostics = computeDiagnostics(uri, workspace);
  expect(diagnostics).toHaveLength(errors);
  expect(diagnostics.every(d => d.code === 'SP100')).toBe(true);
  expect(visits).toBeLessThanOrEqual(tokens.length * 8);
});

it('keeps tooling macro-name ranges in prose, labels and attributes after edits (#253)', () => {
  workspace = new WorkspaceModel();
  const body = '{nosuch}\n[[{absent}|Start]]\n<span title="{missing}">text</span>\n';
  const source = ':: StoryVariables\r\n:: Start\r\n' + body.replaceAll('\n', '\r\n');
  workspace.initialize(new Map([[uri, source]]));
  for (const text of [source, source.replaceAll('nosuch', 'otherUnknown')]) {
    workspace.documents.update(uri, text);
    const doc = TextDocument.create(uri, 'twee', 1, text);
    const content = workspace.markup.get(uri)!.passages[1].content;
    const names = deepTokens(content).flatMap(({ token }) => token.type === 'macro'
      ? [content.slice(token.nameStart, token.nameEnd)] : []);
    const diagnostics = computeDiagnostics(uri, workspace).filter(d => d.code === 'SP100');
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.map(d => d.data?.kind === 'unknown-macro' ? doc.getText(d.data.nameRange) : undefined))
      .toEqual(names);
  }
});

it.each([10, 100])('does not enumerate the whole workspace for each of %i prose passages (#233)', count => {
  workspace = new WorkspaceModel();
  workspace.initialize(new Map([[uri, ':: StoryVariables\n:: Start\nHello\n'
    + Array.from({ length: count }, (_, i) => `:: P${i}\nHello\n`).join('')]]));
  expect(computeDiagnostics(uri, workspace)).toEqual([]);
  const enumerate = vi.spyOn(workspace.passages, 'getEffectivePassages');
  expect(computeDiagnostics(uri, workspace)).toEqual([]);
  expect(enumerate.mock.calls.length).toBeLessThanOrEqual(2);
});

it('shares configured passage validation and refreshes it after edits and replacements (#233)', () => {
  workspace = new WorkspaceModel();
  const text = ':: StoryVariables\n:: Start\n{visit "Target"}\n:: Other\n{visit "Target"}\n:: Target\nHello';
  workspace.initialize(new Map([[uri, text]]));
  workspace.macros.loadSupplements({ visit: { name: 'visit', parameters: ['passage'] } });
  const parameterErrors = () => computeDiagnostics(uri, workspace).filter(d => d.code === 'SP110');
  expect(parameterErrors()).toEqual([]);
  const enumerate = vi.spyOn(workspace.passages, 'getEffectivePassages');
  expect(parameterErrors()).toEqual([]);
  expect(enumerate.mock.calls.length).toBeLessThanOrEqual(2);
  workspace.documents.open('file:///z.tw', ':: Target [script]\n// not a runtime passage');
  expect(parameterErrors()).toHaveLength(2);
  workspace.documents.close('file:///z.tw');
  expect(parameterErrors()).toEqual([]);
  workspace.documents.update(uri, text.replace(':: Target\n', ':: Renamed\n'));
  expect(parameterErrors()).toHaveLength(2);
  workspace.documents.update(uri, text);
  expect(parameterErrors()).toEqual([]);
});
