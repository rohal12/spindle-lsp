import { afterEach, expect, it } from 'vitest';
import { compile } from '@rohal12/twee-ts';
import { openPlaySession } from '@rohal12/spindle/play';
import { fileURLToPath } from 'node:url';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'file:///story.tw';
const models: WorkspaceModel[] = [];
afterEach(() => models.splice(0).forEach(model => model.dispose()));

function source(control: string, children: string) {
  return ':: StoryTitle\nExample\n:: StoryData\n'
    + '{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"}\n'
    + ':: StoryVariables\n$x = "A"\n:: Widgets [widget]\n'
    + '{widget "option" @value}Widget:{@value}{/widget}\n'
    + `:: Start\n{option "standalone"}\n{${control} "$x"}${children}{/${control}}\n`;
}

function workspace(text: string) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text]]));
  return model;
}

it.each(['listbox', 'cycle'])('counts %s choices independently of an option widget (#207)', async control => {
  const text = source(control, '{option "A"}{OpTiOn "B"}');
  const result = await compile({
    sources: [{ filename: uri, content: text }], formatId: 'pkg',
    formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
    noRemote: true, useTweegoPath: false,
  });
  expect(result.diagnostics.filter(d => d.level === 'error')).toEqual([]);
  const session = await openPlaySession({ html: result.output, trusted: true });
  try {
    const observed = await session.observe();
    expect(observed.errors).toEqual([]);
    expect(observed.text).toContain('Widget:standalone');
    expect(observed.actions.find(action => action.type === control)?.options).toEqual(['A', 'B']);
  } finally { await session.close(); }

  const model = workspace(text);
  expect(computeDiagnostics(uri, model).filter(d => d.severity === 'error')).toEqual([]);
  model.documents.update(uri, text.replace('{option "A"}{OpTiOn "B"}', ''));
  expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP115')).toHaveLength(1);
  model.documents.update(uri, text);
  expect(computeDiagnostics(uri, model).filter(d => d.severity === 'error')).toEqual([]);
});

it.each(['listbox', 'cycle'])('requires direct %s choices even with an option widget (#207)', control => {
  for (const children of ['', '<span>{option "A"}</span>', '{if true}{option "A"}{/if}']) {
    const diagnostics = computeDiagnostics(uri, workspace(source(control, children)));
    expect(diagnostics.filter(d => d.code === 'SP115')).toMatchObject([
      { severity: 'error', message: `Too few {option} in {${control}} (min 1, found 0)` },
    ]);
  }
});

it.each(['stop', 'option'])('excludes a %s widget from ordinary configured child constraints', name => {
  const model = workspace(':: StoryVariables\n:: Widgets [widget]\n'
    + `{widget "${name}"}custom{/widget}\n:: Start\n{nobr}{${name}}{${name}}{/nobr}\n`);
  model.macros.loadConfig({ nobr: { children: [{ name, max: 1 }] } });
  expect(computeDiagnostics(uri, model).filter(d => d.severity === 'error')).toEqual([]);

  model.macros.loadConfig({ nobr: { children: [{ name, min: 1 }] } });
  expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP115')).toHaveLength(1);
});
