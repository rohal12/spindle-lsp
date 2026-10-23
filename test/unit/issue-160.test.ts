import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { passagePieces } from '@rohal12/spindle/tooling';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeRename, prepareRename, RenameError } from '../../src/plugins/rename.js';
import { documentPassageRefs } from '../../src/core/markup/passage-refs.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'file:///issue-160.tw';
const models: WorkspaceModel[] = [];
function workspace(parameters: string[], body = '{custom "Hall"}') {
  const model = new WorkspaceModel();
  model.initialize(new Map([[uri, `:: Hall\nWelcome\n:: Start\n${body}`]]));
  model.macros.loadConfig({ custom: { parameters } });
  models.push(model);
  return model;
}
afterEach(() => models.splice(0).forEach(model => model.dispose()));

function renamed(model: WorkspaceModel) {
  const edits = computeRename(uri, { line: 0, character: 4 }, 'Lobby', model);
  return TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, model.documents.getText(uri)!), edits.get(uri) ?? []);
}

describe('#160: configured passage parameters participate in rename', () => {
  it('reports a missing configured destination once using the configured schema diagnostic', () => {
    const model = workspace(['passage'], '{custom "Missing"}');
    expect(computeDiagnostics(uri, model).map(diagnostic => [diagnostic.code, diagnostic.message])).toEqual([
      ['SP110', '{custom}: Nonexistent passage: "Missing"'],
    ]);
  });
  it('renames a configured reference and reads the rewritten name through Spindle', () => {
    const model = workspace(['passage']);
    expect(prepareRename(uri, { line: 3, character: 10 }, model)?.placeholder).toBe('Hall');
    const output = renamed(model);
    expect(output).toBe(':: Lobby\nWelcome\n:: Start\n{custom "Lobby"}');
    expect(passagePieces('{custom "Lobby"}', model.macros.toolingMacros())
      .filter(piece => piece.kind === 'passage').map(piece => piece.name)).toEqual(['Lobby']);
    model.documents.update(uri, output);
    expect(documentPassageRefs(model.markup.get(uri)!).map(ref => ref.name)).toEqual(['Lobby']);
    expect(model.passages.getPassage('Lobby')).toBeDefined();
    expect(model.passages.getPassage('Hall')).toBeUndefined();
  });

  it.each([
    ['string &+ passage'],
    ["('go' | 'visit') &+ passage"],
    ['string &+ passage', 'number &+ passage'],
    ['string &+ (passage |+ number)'],
  ])('keeps ordinary strings unchanged for consistent positions in %j', (...parameters) => {
    const model = workspace(parameters, '{custom "Hall" "H\\x61ll"} {print "Hall"}');
    expect(renamed(model)).toBe(':: Lobby\nWelcome\n:: Start\n{custom "Hall" "Lobby"} {print "Hall"}');
  });

  it.each([
    ['passage | string'],
    ['passage', 'string'],
    ['...passage'],
    ['...string | passage'],
    ['passage | ...string'],
    ['string &+ ...string', 'string &+ passage'],
    ['(passage |+ string) &+ string'],
    [Array.from({ length: 17 }, (_, index) => index === 16 ? 'string' : 'passage').join(' | ')],
  ])('rejects ambiguous or repeated passage positions in %j before returning edits', (...parameters) => {
    const model = workspace(parameters);
    expect(() => renamed(model)).toThrow(RenameError);
    expect(() => renamed(model)).toThrow(/custom.*configured.*passage/i);
    expect(model.documents.getText(uri)).toContain(':: Hall');
  });

  it('does not refuse because of an unused ambiguous macro or its name in text', () => {
    const model = workspace(['passage | string'], '<!-- {custom "Hall"} -->\ncustom "Hall"\n{goto "Hall"}');
    expect(renamed(model)).toContain('{goto "Lobby"}');
  });

  it('refuses conflicting configured and discovered passage roles atomically', () => {
    const model = workspace(['string']);
    model.macros.setDiscoveredMacros([{ name: 'custom', block: false, subMacros: [], parameters: [{ name: 'target', type: 'passage' }] }]);
    expect(() => renamed(model)).toThrow(RenameError);
    expect(model.documents.getText(uri)).toBe(':: Hall\nWelcome\n:: Start\n{custom "Hall"}');
  });

  it('uses consistent discovered passage metadata once without overlapping edits', () => {
    const model = workspace(['passage']);
    model.macros.setDiscoveredMacros([{ name: 'custom', block: false, subMacros: [], parameters: [{ name: 'target', type: 'passage' }] }]);
    expect(documentPassageRefs(model.markup.get(uri)!)).toHaveLength(1);
    expect(renamed(model)).toBe(':: Lobby\nWelcome\n:: Start\n{custom "Lobby"}');
  });

  it('allows unrelated passage renames with ordinary configured and discovered strings', () => {
    const model = workspace(['string'], '{custom "Hall"} {goto "Hall"}');
    model.macros.setDiscoveredMacros([{ name: 'custom', block: false, subMacros: [], parameters: [{ name: 'label', type: 'string' }] }]);
    expect(renamed(model)).toBe(':: Lobby\nWelcome\n:: Start\n{custom "Hall"} {goto "Lobby"}');
  });

  it('renames destinations whose runtime parameter array is generated dynamically', () => {
    const model = new WorkspaceModel();
    models.push(model);
    model.macros.loadConfig({ custom: { parameters: ['passage'] } });
    const script = `const definition = { name: "custom", parameters: ["target"].map(name => ({ name, type: "passage", required: true })), render() { return null; } }; Story.defineMacro(definition);`;
    model.initialize(new Map([[uri, `:: Hall\nWelcome\n:: Start\n{custom "Hall"}\n:: Macros [script]\n${script}`]]));
    expect(model.macros.getMacro('custom')?.parameterDefs).toBeUndefined();
    expect(renamed(model)).toBe(`:: Lobby\nWelcome\n:: Start\n{custom "Lobby"}\n:: Macros [script]\n${script}`);
  });
});
