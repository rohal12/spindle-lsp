import { afterEach, expect, it, vi } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CodeAction, CodeActionParams, Connection } from 'vscode-languageserver';
import { StoryBuilder, passageOmission } from '@rohal12/twee-ts';
import { discoverMacros } from '@rohal12/spindle/tooling';
import { macroTokens } from '../../src/core/markup/tokens.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeCodeActions, codeActionsPlugin } from '../../src/plugins/code-actions.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'memory:///story.tw';
const models: WorkspaceModel[] = [];
function workspace(text: string, files = new Map<string, string>()) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text], ...files]));
  return model;
}
afterEach(() => {
  vi.restoreAllMocks();
  models.splice(0).forEach(model => model.dispose());
});

it.each([100, 200])('bounds identity reads when revalidating %i diagnostics (#274)', count => {
  const model = workspace(':: StoryVariables\n:: Start\n' + '{badzzmacro}'.repeat(count));
  const diagnostics = computeDiagnostics(uri, model);
  expect(diagnostics).toHaveLength(count);
  let reads = 0;
  const supplied = diagnostics.map(diagnostic => ({
    ...diagnostic,
    get code() { reads++; return diagnostic.code; },
  }));
  expect(computeCodeActions(uri, supplied, model)).toEqual([]);
  expect(reads).toBeLessThan(count * 20);
});

it('rejects stale same-range data and moved ranges while accepting current fixes (#274)', () => {
  const source = ':: StoryVariables\n:: Start\n{prnit 1}{prnit 2}';
  const model = workspace(source);
  const diagnostics = computeDiagnostics(uri, model);
  const stale = structuredClone(diagnostics[0]);
  if (stale.data?.kind !== 'unknown-macro') throw new Error('expected macro data');
  stale.data.nameRange.start.character++;
  const moved = structuredClone(diagnostics[0]);
  moved.range = diagnostics[1].range;
  expect(computeCodeActions(uri, [stale, moved], model)).toEqual([]);
  const actions = computeCodeActions(uri, diagnostics, model);
  expect(actions).toHaveLength(2);
  const changed = TextDocument.applyEdits(TextDocument.create(uri, 'twee3', 1, source), actions.flatMap(action => action.edits));
  model.documents.update(uri, changed);
  expect(computeDiagnostics(uri, model)).toEqual([]);
  expect(computeCodeActions(uri, diagnostics, model)).toEqual([]);
});

function lspActions(model: WorkspaceModel, params: CodeActionParams) {
  let handler!: (params: CodeActionParams) => CodeAction[];
  codeActionsPlugin.initialize({
    workspace: model, config: {},
    connection: { onCodeAction(callback: typeof handler) { handler = callback; } } as unknown as Connection,
  });
  return handler(params);
}

it.each([2, 100])('associates each of %i same-code LSP fixes with its originating diagnostic (#275)', count => {
  const model = workspace(':: StoryVariables\n:: Start\n' + '{prnit 1}'.repeat(count));
  const diagnostics = computeDiagnostics(uri, model).map((diagnostic, i) => ({
    ...diagnostic, severity: 1, codeDescription: { href: `https://example.com/diagnostic/${i}` },
  }));
  expect(diagnostics).toHaveLength(count);
  const actions = lspActions(model, {
    textDocument: { uri }, range: { start: { line: 2, character: 0 }, end: { line: 2, character: count * 9 } },
    context: { diagnostics },
  });
  expect(actions).toHaveLength(count);
  expect(actions.reduce((total, action) => total + action.diagnostics!.length, 0)).toBe(count);
  for (const [i, action] of actions.entries()) {
    expect(action.diagnostics).toEqual([diagnostics[i]]);
    expect(action.edit!.changes![uri][0].range).toEqual(diagnostics[i].data!.nameRange);
  }
  expect(JSON.stringify(actions).length).toBeLessThan(count * 1500);
});

it.each([100, 200])('bounds token and widget-source reads for %i includes (#276)', count => {
  const definitions = Array.from({ length: count }, (_, i) => `:: W${i} [widget]\n{widget "w${i}"}Hi{/widget}\n`).join('');
  const model = workspace(':: StoryVariables\n' + definitions + ':: Start\n' + '{include "W0"}\n'.repeat(count));
  expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP302')).toHaveLength(count);
  let tokenReads = 0;
  let sourceReads = 0;
  const passages = model.markup.get(uri)!.passages;
  for (const token of macroTokens(passages.at(-1)!)) {
    const name = token.name;
    Object.defineProperty(token, 'name', { configurable: true, get() { tokenReads++; return name; } });
  }
  for (const markup of passages.slice(1, -1)) {
    const passage = markup.passage;
    Object.defineProperty(markup, 'passage', { configurable: true, get() { sourceReads++; return passage; } });
  }
  expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP302')).toHaveLength(count);
  expect(tokenReads).toBeLessThan(count * 20);
  expect(sourceReads).toBeLessThan(count * 30);
});

it('keeps contextual include warnings and source spans current in labels and attributes (#276)', () => {
  const source = ':: StoryVariables\r\n:: W [widget]\r\n{widget "hello"}Hi{/widget}\r\n'
    + ':: Start\r\n{include "W"}\r\n{button "{include \'W\'}"}Go{/button}\r\n'
    + '<span title="{INCLUDE \'W\'}">Hi</span>\r\n{include W}\r\n';
  const model = workspace(source);
  const warnings = () => computeDiagnostics(uri, model).filter(d => d.code === 'SP302');
  const doc = TextDocument.create(uri, 'twee3', 1, source);
  expect(warnings().map(d => doc.getText(d.range))).toEqual(['{include "W"}', "{include 'W'}", "{INCLUDE 'W'}"]);
  expect(warnings().every(d => d.message.includes('{hello}'))).toBe(true);
  model.documents.update(uri, source.replace('[widget]', ''));
  expect(warnings()).toEqual([]);
  model.documents.update(uri, source);
  expect(warnings()).toHaveLength(3);
  model.documents.open('memory:///overrides.tw', ':: Override [widget]\n{widget "include" @target:passage}Replacement{/widget}');
  expect(warnings()).toEqual([]);
  model.documents.close('memory:///overrides.tw');
  expect(warnings()).toHaveLength(3);
});

it.each(['StoryData', 'StoryTitle', 'StorySettings'])('does not create an unusable empty %s destination (#277)', name => {
  const model = workspace(`:: StoryVariables\n:: Start\n[[${name}]]`);
  const diagnostics = computeDiagnostics(uri, model).filter(d => d.code === 'SP300');
  expect(diagnostics).toHaveLength(1);
  const builder = new StoryBuilder();
  builder.add({ name, text: '', tags: [] }, []);
  const story = builder.build();
  const passage = story.passages.find(p => p.name === name);
  expect(!passage || passageOmission(story, passage, 'twine2') !== undefined).toBe(true);
  expect(computeCodeActions(uri, diagnostics, model).filter(a => a.title === `Create passage '${name}'`)).toEqual([]);
  expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP003')).toEqual([]);
});

it.each(['Hall', 'StoryScript', 'StoryIncludes'])('creates a usable empty %s destination and resolves its link (#277)', name => {
  const source = `:: StoryVariables\n:: Start\n[[${name}]]`;
  const model = workspace(source);
  const diagnostics = computeDiagnostics(uri, model).filter(d => d.code === 'SP300');
  expect(diagnostics).toHaveLength(1);
  const action = computeCodeActions(uri, diagnostics, model).find(a => a.title === `Create passage '${name}'`)!;
  expect(action).toBeDefined();
  const changed = TextDocument.applyEdits(TextDocument.create(uri, 'twee3', 1, source), action.edits);
  model.documents.update(uri, changed);
  expect(computeDiagnostics(uri, model).filter(d => ['SP300', 'SP003'].includes(d.code))).toEqual([]);
  const builder = new StoryBuilder();
  builder.add({ name, text: '', tags: [] }, []);
  const story = builder.build();
  expect(passageOmission(story, story.passages.find(p => p.name === name)!, 'twine2')).toBeUndefined();
});

it.each(['js', 'ts', 'script', 'StoryInit'])('initializes and refreshes a large %s discovery batch without an argument-limit crash (#278)', kind => {
  const definition = (description: string) => `Story.defineMacro({name:"large",description:"${description}",render(){}});\n`;
  const code = definition('first').repeat(140000) + definition('last');
  // The parser accepts the flat source, including the final replacement.
  const found = discoverMacros(code);
  expect(found).toHaveLength(140001);
  expect(found.at(-1)?.description).toBe('last');
  const standalone = kind === 'js' || kind === 'ts';
  const sourceUri = standalone ? `memory:///macros.${kind}` : uri;
  const source = (body: string) => standalone ? body
    : ':: StoryVariables\n:: Start\nHi\n' + (kind === 'script'
      ? `:: Macros [script]\n${body}` : `:: StoryInit\n{do}\n${body}{/do}`);
  const model = workspace(standalone ? ':: StoryVariables\n:: Start\nHi' : source(code),
    standalone ? new Map([[sourceUri, code]]) : undefined);
  expect(model.initialized).toBe(true);
  expect(model.macros.getMacro('large')?.description).toBe('last');
  model.documents.update(sourceUri, source(definition('edited')));
  expect(model.macros.getMacro('large')?.description).toBe('edited');
  model.documents.update(sourceUri, source(''));
  expect(model.macros.getMacro('large')).toBeUndefined();
});
