import { afterEach, expect, it, vi } from 'vitest';
import * as tooling from '@rohal12/spindle/tooling';
import type { CodeAction, CodeActionParams, Connection, ExecuteCommandParams, WorkspaceEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeCodeActions, codeActionsPlugin } from '../../src/plugins/code-actions.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

// Count the real public API's work without replacing its parsing behavior.
vi.mock('@rohal12/spindle/tooling', async importOriginal => {
  const actual = await importOriginal<typeof tooling>();
  return { ...actual, passagePieces: vi.fn(actual.passagePieces) };
});

const uri = 'untitled:story.tw';
const models: WorkspaceModel[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const model of models.splice(0)) model.dispose();
});

function workspace(text: string) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text]]));
  return model;
}

it.each([400, 800])('bounds lookup and rewrite-validation work for %i links on one line (#321)', count => {
  const model = workspace(':: StoryVariables\n:: Target\nHi\n:: Start\n' + '[[Targte]]'.repeat(count));
  const diagnostics = computeDiagnostics(uri, model);
  expect(diagnostics).toHaveLength(count);
  const parse = vi.mocked(tooling.passagePieces);
  parse.mockClear();
  const passage = model.markup.get(uri)!.passages.at(-1)!;
  const pieces = passage.pieces;
  let visits = 0;
  vi.spyOn(passage, 'pieces', 'get').mockReturnValue(new Proxy(pieces, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) visits++;
      return Reflect.get(target, key, receiver);
    },
  }));
  const actions = computeCodeActions(uri, diagnostics, model);
  expect(actions).toHaveLength(count * 2);
  const spelling = actions.filter(action => action.title === "Change to 'Target'");
  expect(spelling).toHaveLength(count);
  expect(spelling.filter(action => action.deferred).length).toBeGreaterThan(count / 2);
  const rewrites = parse.mock.calls.filter(([text]) => text.includes('[[Target]]'));
  expect(rewrites.length).toBeGreaterThan(0);
  expect(rewrites.reduce((size, [text]) => size + text.length, 0)).toBeLessThanOrEqual(100_000);
  expect(visits).toBeLessThan(count * 15);
});

it.each([128, 256])('shares document lookup across %i separate passages (#321)', count => {
  const source = ':: StoryVariables\n:: Target\nHi\n'
    + Array.from({ length: count }, (_, i) => `:: P${i}\n[[Targte]]\n`).join('');
  const model = workspace(source);
  const diagnostics = computeDiagnostics(uri, model);
  const doc = model.markup.get(uri)!;
  let reads = 0;
  for (const passage of doc.passages) {
    const pieces = passage.pieces;
    vi.spyOn(passage, 'pieces', 'get').mockImplementation(() => { reads++; return pieces; });
  }
  const parse = vi.mocked(tooling.passagePieces);
  parse.mockClear();
  const actions = computeCodeActions(uri, diagnostics, model);
  expect(actions).toHaveLength(count * 2);
  expect(actions.every(action => !action.deferred)).toBe(true);
  expect(reads).toBeLessThan(count * 12);
  const rewrites = parse.mock.calls.filter(([text]) => text.includes('[[Target]]'));
  expect(rewrites).toHaveLength(count);
  expect(rewrites.reduce((size, [text]) => size + text.length, 0)).toBeLessThan(count * 30);
  const edits = actions.filter(action => action.title === "Change to 'Target'").flatMap(action => action.edits);
  const rewritten = TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, source), edits);
  expect(rewritten).toBe(source.replaceAll('[[Targte]]', '[[Target]]'));
  model.documents.update(uri, rewritten);
  expect(computeDiagnostics(uri, model)).toEqual([]);
});

function handlers(model: WorkspaceModel, versioned = true, canApplyEdit = true) {
  let actions!: (params: CodeActionParams) => CodeAction[];
  let execute!: (params: ExecuteCommandParams) => Promise<unknown>;
  const applyEdit = vi.fn(async (_edit: WorkspaceEdit) => ({ applied: true }));
  codeActionsPlugin.initialize({
    workspace: model, config: {}, canApplyEdit,
    ...(versioned ? { documentVersion: () => 3 } : {}),
    connection: {
      onCodeAction(callback: typeof actions) { actions = callback; },
      onExecuteCommand(callback: typeof execute) { execute = callback; },
      workspace: { applyEdit },
    } as unknown as Connection,
  });
  return { actions, execute, applyEdit };
}

function deferredFixture(versioned = true) {
  const source = ':: StoryVariables\n:: Target\nHi\n:: Start\n' + '[[Targte]]'.repeat(800);
  const model = workspace(source);
  const plugin = handlers(model, versioned);
  const diagnostics = computeDiagnostics(uri, model).map(d => ({ ...d, severity: 1 }));
  const actions = plugin.actions({
    textDocument: { uri }, context: { diagnostics }, range: diagnostics.at(-1)!.range,
  });
  expect(actions).toHaveLength(1600);
  const action = actions.findLast(action => action.title === "Change to 'Target'" && action.command)!;
  expect(action).toBeDefined();
  expect(action.edit).toBeUndefined();
  expect(action.diagnostics).toEqual([diagnostics.at(-1)]);
  return { source, model, plugin, command: action.command! };
}

it('validates and applies a selected deferred fix through the command handler (#321)', async () => {
  const { source, model, plugin, command } = deferredFixture();
  await plugin.execute(command);
  expect(plugin.applyEdit).toHaveBeenCalledTimes(1);
  const edit = plugin.applyEdit.mock.calls[0][0].documentChanges![0] as { edits: import('vscode-languageserver').TextEdit[] };
  expect(edit).toMatchObject({ textDocument: { uri, version: 3 } });
  const rewritten = TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, source), edit.edits);
  expect(rewritten).toBe(source.slice(0, -10) + '[[Target]]');
  model.documents.update(uri, rewritten);
  expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP300')).toHaveLength(799);
});

it('applies a deferred fix for clients without versioned-edit support (#321)', async () => {
  const { source, plugin, command } = deferredFixture(false);
  await plugin.execute(command);
  expect(plugin.applyEdit).toHaveBeenCalledTimes(1);
  const edit = plugin.applyEdit.mock.calls[0][0];
  expect(edit.documentChanges).toBeUndefined();
  const rewritten = TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, source), edit.changes![uri]);
  expect(rewritten).toBe(source.slice(0, -10) + '[[Target]]');
});

it.each(['moved', 'data', 'suggestion', 'closed'])('rejects a deferred fix after its %s state changes (#321)', async change => {
  const { source, model, plugin, command } = deferredFixture();
  if (change === 'moved') model.documents.update(uri, '\n' + source);
  if (change === 'closed') model.documents.close(uri);
  if (change === 'suggestion') model.documents.update(uri, source.replace(':: Target', ':: Elsewhere'));
  if (change === 'data') command.arguments![1].data.name = 'Different';
  await plugin.execute(command);
  expect(plugin.applyEdit).not.toHaveBeenCalled();
});

it('ignores malformed or unrelated execute-command arguments (#321)', async () => {
  const plugin = handlers(workspace(':: Start\nHi\n'));
  for (const args of [[], [uri, null, 'x'], [uri, { code: 'SP300', range: {} }, 'x']]) {
    await plugin.execute({ command: 'spindle.applyCodeAction', arguments: args });
  }
  await plugin.execute({ command: 'other' });
  expect(plugin.applyEdit).not.toHaveBeenCalled();
});

it('keeps direct fixes when a client cannot apply server edits (#321)', () => {
  const source = ':: StoryVariables\n:: Target\nHi\n:: Start\n' + 'prose '.repeat(20_000) + '[[Targte]]';
  const model = workspace(source);
  const plugin = handlers(model, false, false);
  const diagnostics = computeDiagnostics(uri, model).map(d => ({ ...d, severity: 1 }));
  expect(diagnostics).toHaveLength(1);
  const actions = plugin.actions({ textDocument: { uri }, context: { diagnostics }, range: diagnostics[0].range });
  const action = actions.find(action => action.title === "Change to 'Target'")!;
  expect(action).toBeDefined();
  expect(action.command).toBeUndefined();
  expect(TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, source), action.edit!.changes![uri]))
    .toBe(source.slice(0, -10) + '[[Target]]');
});
