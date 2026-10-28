import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'file:///story.tw';
let workspace: WorkspaceModel;
afterEach(() => { vi.restoreAllMocks(); workspace?.dispose(); });

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
