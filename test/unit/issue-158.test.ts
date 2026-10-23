import { afterEach, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { compile, decompileHTML } from '@rohal12/twee-ts';
import { builtinMacros, validateStoryMarkup } from '@rohal12/spindle/tooling';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { getDefinition } from '../../src/plugins/definition.js';

const uri = 'file:///story.tw';
const metadata = ':: StoryTitle\nExample\n:: StoryData\n{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"}\n:: StoryVariables\n';
const models: WorkspaceModel[] = [];
function workspace(text: string) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text]]));
  return model;
}
afterEach(() => models.splice(0).forEach(model => model.dispose()));

it.each([
  ['script', false], ['stylesheet', false], ['Twine.private', false],
  ['Script', true], ['Stylesheet', true], ['twine.private', true], ['ordinary', true],
] as const)('checks targets tagged %s against passages emitted by the compiler (#158)', async (tag, emitted) => {
  const text = `${metadata}:: Start\n[[Hidden]] {include "Hidden"} {goto "Hidden"}\n:: Hidden [${tag}]\n/* Hello */`;
  const model = workspace(text);
  const compiled = await compile({
    sources: [{ filename: uri, content: text }],
    formatId: 'pkg',
    formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
    noRemote: true,
    useTweegoPath: false,
  });
  expect(compiled.diagnostics).toEqual([]);
  const passages = decompileHTML(compiled.output).story.passages;
  expect(passages.some(passage => passage.name === 'Hidden')).toBe(emitted);
  const expected = validateStoryMarkup(passages.map(passage => ({ ...passage, content: passage.text })), builtinMacros, { tolerant: true })
    .filter(diagnostic => diagnostic.code === 'unknown-passage');
  const found = computeDiagnostics(uri, model).filter(diagnostic => diagnostic.code === 'SP300');
  expect(found.map(diagnostic => diagnostic.message)).toEqual(expected.map(diagnostic => diagnostic.message));
  expect(found).toHaveLength(emitted ? 0 : 3);
  // Sources remain available for author navigation, even when not emitted.
  expect(getDefinition(uri, { line: 6, character: 4 }, model)?.range.start.line).toBe(7);
});

it('does not validate omitted private markup or register its widgets (#158)', () => {
  const model = workspace(`${metadata}:: Start\n{hidden}\n:: Hidden [Twine.private widget]\n`
    + '{widget hidden @arg}{unknown} [[Absent]] {if $missing}{/widget}');
  expect(computeDiagnostics(uri, model)).toEqual([expect.objectContaining({
    code: 'SP100', message: 'Unknown macro {hidden}.', range: expect.objectContaining({ start: { line: 6, character: 0 } }),
  })]);
});

it('keeps macros discovered in compiler script passages (#158)', () => {
  const model = workspace(`${metadata}:: Start\n{custom}\n:: Code [script]\n`
    + 'Story.defineMacro({name:"custom",render(){return null;}});');
  expect(model.macros.getMacro('custom')).toBeDefined();
  expect(computeDiagnostics(uri, model)).toEqual([]);
});

it('refreshes target availability when tags change in another document (#158)', () => {
  const model = workspace(`${metadata}:: Start\n[[Hidden]]`);
  const targetUri = 'file:///target.tw';
  model.documents.open(targetUri, ':: Hidden\nHello');
  expect(computeDiagnostics(uri, model).filter(diagnostic => diagnostic.code === 'SP300')).toEqual([]);
  for (const tag of ['script', 'stylesheet', 'Twine.private']) {
    model.documents.update(targetUri, `:: Hidden [${tag}]\n/* Hello */`);
    expect(computeDiagnostics(uri, model).filter(diagnostic => diagnostic.code === 'SP300')).toHaveLength(1);
    model.documents.update(targetUri, ':: Hidden\nHello');
    expect(computeDiagnostics(uri, model).filter(diagnostic => diagnostic.code === 'SP300')).toEqual([]);
  }
});

it('uses emitted targets for project passage parameter schemas (#158)', () => {
  const model = workspace(`${metadata}:: Start\n{custom "Code"} {custom "Style"} {custom "Hidden"} {custom "Ordinary"}\n`
    + ':: Code [script]\n/* Hello */\n:: Style [stylesheet]\n/* Hello */\n:: Hidden [Twine.private]\nHello\n:: Ordinary\nHello');
  model.macros.loadConfig({ custom: { parameters: ['passage'] } });
  expect(computeDiagnostics(uri, model).filter(diagnostic => diagnostic.code === 'SP110').map(diagnostic => diagnostic.message)).toEqual([
    '{custom}: Nonexistent passage: "Code"', '{custom}: Nonexistent passage: "Style"', '{custom}: Nonexistent passage: "Hidden"',
  ]);
});
