import { afterEach, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { compile, decompileHTML } from '@rohal12/twee-ts';
import { openPlaySession } from '@rohal12/spindle/play';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeRename, prepareRename } from '../../src/plugins/rename.js';
import { findReferences } from '../../src/plugins/references.js';
import { getCompletions } from '../../src/plugins/completions.js';

const uri = 'file:///a-story.tw';
const laterUri = 'file:///z-declarations.tw';
const macroUri = 'file:///macros.js';
const metadata = ':: StoryTitle\nExample\n:: StoryData\n{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"}\n';
const models: WorkspaceModel[] = [];
function workspace(files: Map<string, string>) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(files);
  return model;
}
const document = (path: string, text: string) => TextDocument.create(path, 'twee3', 1, text);
afterEach(() => models.splice(0).forEach(model => model.dispose()));

async function compiled(files: Map<string, string>) {
  return compile({
    sources: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([filename, content]) => ({ filename, content })),
    formatId: 'pkg',
    formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
    noRemote: true,
    useTweegoPath: false,
  });
}
async function rendered(files: Map<string, string>) {
  const result = await compiled(files);
  expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
  const session = await openPlaySession({ html: result.output, trusted: true });
  try {
    const observation = await session.observe();
    expect(observation.errors).toEqual([]);
    return observation.text;
  } finally { await session.close(); }
}

for (const eol of ['\n', '\r\n']) for (const separate of [false, true]) {
  for (const [name, sigil] of [['StoryVariables', '$'], ['StoryTransients', '%']] as const) {
    it(`uses and renames the effective ${name} (${separate}, EOL ${eol.length}) (#171)`, async () => {
      const early = `${metadata}:: StoryVariables\n${name === 'StoryTransients' ? ':: StoryTransients\n' : ''}${sigil}x = 1\n`;
      const later = `:: ${name}\n${sigil}x = 2\n`;
      const usage = `:: Start\n{${sigil}x}\n`;
      const text = (early + (separate ? '' : later) + usage).replaceAll('\n', eol);
      // Open in reverse order to ensure source selection does not depend on arrival order.
      const files = new Map(separate ? [[laterUri, later.replaceAll('\n', eol)], [uri, text]] : [[uri, text]]);
      const model = workspace(files);
      const at = document(uri, text).positionAt(text.lastIndexOf(`${sigil}x`) + 1);
      const effective = model.passages.getEffectivePassage(name)!;
      expect(effective.uri).toBe(separate ? laterUri : uri);
      expect(computeDiagnostics(uri, model).filter(d => d.severity === 'error')).toEqual([]);
      expect(await rendered(files)).toBe('2');
      const refs = findReferences(uri, at, model, true);
      expect(refs).toHaveLength(2);
      expect(refs.some(ref => ref.uri === effective.uri && ref.range.start.line === effective.headerEnd.end.line + 1)).toBe(true);
      const declared = sigil === '$' ? model.variables.getDeclared() : model.variables.getDeclaredTransient();
      expect(declared.get('x')?.declarationUri).toBe(effective.uri);
      const edits = computeRename(uri, at, 'changed', model);
      const changed = new Map([...files].map(([path, content]) => [path, TextDocument.applyEdits(document(path, content), edits.get(path) ?? [])]));
      expect(changed.get(uri)).toContain(`${sigil}x = 1`);
      expect(changed.get(effective.uri)).toContain(`${sigil}changed = 2`);
      expect(await rendered(changed)).toBe('2');
      const updated = workspace(changed);
      expect(computeDiagnostics(uri, updated).filter(d => d.severity === 'error')).toEqual([]);
      const different = new Map([...files].map(([path, content]) => [path, content.replace(`${sigil}x = 2`, `${sigil}y = 2`).replace(`{${sigil}x}`, `{${sigil}y}`)]));
      const distinct = workspace(different);
      expect(computeDiagnostics(uri, distinct).filter(d => d.severity === 'error')).toEqual([]);
      expect(await rendered(different)).toBe('2');
    });
  }
}

it('moves declaration errors and references with unsaved effective-passage changes (#171)', () => {
  const text = ':: StoryVariables\n$x = 1\n:: Start\n{$x}\n';
  const model = workspace(new Map([[uri, text], [laterUri, ':: StoryVariables\n$x =\n']]));
  expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP207')).toEqual([]);
  expect(computeDiagnostics(laterUri, model).filter(d => d.code === 'SP207')).toHaveLength(1);
  expect(prepareRename(uri, { line: 1, character: 1 }, model)).toBeNull();
  model.documents.update(laterUri, ':: StoryVariables\n$x = 2\n');
  expect(computeDiagnostics(laterUri, model).filter(d => d.code === 'SP207')).toEqual([]);
  expect(model.variables.getDeclared().get('x')?.declarationUri).toBe(laterUri);
  model.documents.close(laterUri);
  expect(model.variables.getDeclared().get('x')?.declarationUri).toBe(uri);
});

it.each(['script', 'stylesheet', 'Twine.private'])('does not fall back to an earlier declaration when the later one is omitted (%s) (#171)', tag => {
  const model = workspace(new Map([[uri, `:: StoryVariables\n$x = 1\n:: StoryVariables [${tag}]\nignored\n:: Start\n{$x}`]]));
  expect(model.variables.hasStoryVariables()).toBe(false);
  expect(model.variables.getDeclared().size).toBe(0);
});

it.each(['', 'undo: on\n'])('offers only emitted, bracket-representable destinations (settings %j) (#172)', async settings => {
  const text = `${metadata}:: StoryVariables\n:: Start\n[[H]]\n:: Hall\nRoom\n:: Hidden [script]\nconsole.log("test");\n:: Draft [Twine.private]\nDraft\n:: Style [stylesheet]\na {}\n:: StorySettings\n${settings}:: A\\[B\nBrackets\n:: A|B\nPipe\n`;
  const files = new Map([[uri, text]]);
  const model = workspace(files);
  const at = document(uri, text).positionAt(text.indexOf('[[H]]') + 3);
  const items = getCompletions(uri, at, undefined, model);
  const labels = items.map(item => item.label);
  const emitted = decompileHTML((await compiled(files)).output).story.passages.map(p => p.name);
  expect(labels).toContain('Hall');
  expect(labels).not.toContain('A|B');
  expect(labels).toContain('A[B');
  expect(labels.includes('StorySettings')).toBe(emitted.includes('StorySettings'));
  for (const label of labels) expect(emitted).toContain(label);
  for (const label of ['Hidden', 'Draft', 'Style', 'StoryTitle', 'StoryData']) {
    expect(labels).not.toContain(label);
    expect(model.passages.getPassage(label)).toBeDefined();
  }
  const hall = items.find(item => item.label === 'Hall')!;
  const changed = TextDocument.applyEdits(document(uri, text), [hall.textEdit as { range: any; newText: string }]);
  expect(changed).toContain('[[Hall]]');
  expect(await rendered(new Map([[uri, changed]]))).toBe('Hall');
});

for (const name of ['computed', 'set', 'for', 'link', 'button']) {
  it(`respects effective ${name} semantics and restores built-in loop checks after removal (#173)`, () => {
    const deferred = name === 'link' || name === 'button';
    const assignment = name === 'set' ? 'set' : 'computed';
    const body = `{${assignment} _t = @i}{_t}`;
    const loop = `{for @i of [1,2]}${deferred ? `{${name} "Go"}${body}{/${name}}` : body}{/for}`;
    const text = `:: StoryVariables\n:: Start\n{set _t = 5}${loop}`;
    const definition = `Story.defineMacro({name:${JSON.stringify(name)},block:${name === 'for' || deferred},render(){return "OK";}});`;
    const model = workspace(new Map([[uri, text], [macroUri, definition]]));
    const warnings = () => computeDiagnostics(uri, model).filter(d => d.code === 'SP205');
    expect(warnings()).toHaveLength(deferred ? 1 : 0);
    model.documents.update(macroUri, '');
    expect(warnings()).toHaveLength(deferred ? 0 : 1);
    model.documents.update(macroUri, definition);
    expect(warnings()).toHaveLength(deferred ? 1 : 0);
  });
}

it('matches successful runtime behavior for a computed replacement (#173)', async () => {
  const text = `${metadata}:: StoryVariables\n:: Macros [script]\nStory.defineMacro({name:"computed",render(){return "OK";}});\n:: Start\n{set _t = 5}{for @i of [1,2]}{computed _t = @i}{_t}{/for}`;
  const files = new Map([[uri, text]]);
  expect(computeDiagnostics(uri, workspace(files)).filter(d => d.code === 'SP205')).toEqual([]);
  expect(await rendered(files)).toBe('OK5OK5');
});

it.each(['\n', '\r\n'])('preserves workspace link argument roles and invalidates them on unsaved changes (EOL %i) (#174)', async eol => {
  const definition = 'Story.defineMacro({name:"link",block:true,parameters:[{name:"first",type:"string"},{name:"second",type:"string"}],render(){return "OK";}});';
  const text = `${metadata}:: StoryVariables\n:: Macros [script]\n${definition}\n:: Start\n{link "label" "Room{$n}"}{/link}`.replaceAll('\n', eol);
  const files = new Map([[uri, text]]);
  const model = workspace(files);
  const warnings = () => computeDiagnostics(uri, model).filter(d => d.code === 'SP305');
  expect(warnings()).toEqual([]);
  expect(await rendered(files)).toBe('OK');
  model.documents.update(uri, text.replace(definition, ''));
  expect(warnings()).toHaveLength(1);
  expect(document(uri, text.replace(definition, '')).getText(warnings()[0].range)).toBe('{$n}');
  model.documents.update(uri, text);
  expect(warnings()).toEqual([]);
  model.documents.update(uri, text.replace('type:"string"}],', 'type:"passage"}],'));
  expect(warnings()).toHaveLength(1);
});
