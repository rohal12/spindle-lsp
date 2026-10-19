import { afterEach, expect, it, vi } from 'vitest';
import type { Connection } from 'vscode-languageserver';
import { fileURLToPath } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { compile } from '@rohal12/twee-ts';
import { openPlaySession } from '@rohal12/spindle/play';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics, diagnosticsPlugin } from '../../src/plugins/diagnostics.js';
import { computeRename, prepareRename } from '../../src/plugins/rename.js';

const uri = 'file:///story.tw';
const compilerOptions = {
  formatId: 'pkg',
  formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
  noRemote: true,
  useTweegoPath: false,
};
const models: WorkspaceModel[] = [];
function workspace(files: Array<[string, string]>) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map(files));
  return model;
}
afterEach(() => {
  models.splice(0).forEach(model => model.dispose());
  vi.useRealTimers();
});

function renamed(model: WorkspaceModel, at: { line: number; character: number }, name: string) {
  const edits = computeRename(uri, at, name, model);
  return model.documents.getUris().map(filename => ({
    filename,
    content: TextDocument.applyEdits(TextDocument.create(filename, 'twee', 0, model.documents.getText(filename)!), edits.get(filename) ?? []),
  }));
}
const metadata = ':: StoryTitle\nExample\n:: StoryData\n{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"';

for (const scriptPassage of [false, true]) {
  for (const reverse of [false, true]) {
    it(`applies StoryInit after story JavaScript (${scriptPassage}, ${reverse}, #140)`, async () => {
      const define = (type: string) => `Story.defineMacro({name:"caption",parameters:[{name:"value",${type}}],render(props,ctx){return "INIT:"+ctx.args.value;}});`;
      const init = define('type:"string"');
      const script = define('type:"text",holds:"markup"');
      const story = `${metadata}}\n:: StoryVariables\n$x = 1\n:: StoryInit\n{do}${init}{/do}\n:: Start\n{caption "{$x}"}`;
      const files: Array<[string, string]> = [[uri, story], scriptPassage
        ? ['file:///z.tw', `:: Macros [script]\n${script}`]
        : ['file:///z.js', script]];
      const model = workspace(reverse ? files.reverse() : files);
      expect(model.macros.getMacro('caption')?.parameterDefs).toEqual([{ name: 'value', type: 'string' }]);
      expect(model.variables.getUsages('x')).toEqual([]);
      expect(computeDiagnostics(uri, model).filter(d => d.severity === 'error')).toEqual([]);
      const sources = renamed(model, { line: 5, character: 1 }, 'other');
      expect(sources.find(s => s.filename === uri)!.content).toContain('{caption "{$x}"}');
      expect(sources.find(s => s.filename === uri)!.content).toContain('$other = 1');
      // The runtime confirms the effective parameter is literal. Its early
      // pre-StoryInit variable check is tracked in rohal12/spindle#601.
      const compiled = await compile({ sources: files.map(([filename, content]) => ({ filename, content })), ...compilerOptions });
      expect(compiled.diagnostics).toEqual([]);
      const session = await openPlaySession({ html: compiled.output });
      try {
        expect(await session.observe()).toMatchObject({ text: 'INIT:{$x}', errors: [] });
      } finally { await session.close(); }
    });
  }
}

it('keeps discovery precedence stable when script sources are reopened (#140)', () => {
  const model = workspace([
    [uri, ':: StoryVariables\n:: Start\n{caption "{$x}"}'],
    ['file:///z.js', 'Story.defineMacro({name:"caption",parameters:[{name:"value",type:"string"}]});'],
    ['file:///a.js', 'Story.defineMacro({name:"caption",parameters:[{name:"value",type:"text",holds:"markup"}]});'],
  ]);
  expect(model.variables.getUsages('x')).toEqual([]);
  const text = model.documents.getText('file:///a.js')!;
  model.documents.close('file:///a.js');
  model.documents.open('file:///a.js', text);
  expect(model.variables.getUsages('x')).toEqual([]);
});

it.each([
  ['Start', ',"start":"Start"'],
  ['Opening', ',"start":"Opening"'],
  ['Start', ''],
  ['Start', ',"start":""'],
])('preserves entry %s with metadata %s through applied rename and compilation (#141)', async (entry, start) => {
  const text = `${metadata}${start}}\n:: StoryVariables\n:: ${entry}\nHello.\n:: Other\n[[${entry}]]`;
  const model = workspace([[uri, text]]);
  const sources = renamed(model, { line: 5, character: 4 }, 'New Opening');
  expect(sources[0].content).toContain('[[New Opening]]');
  const compiled = await compile({ sources, ...compilerOptions });
  expect(compiled.diagnostics).toEqual([]);
  expect(compiled.story.twine2.start).toBe('New Opening');
  const session = await openPlaySession({ html: compiled.output });
  try { expect(await session.observe()).toMatchObject({ passage: 'New Opening', text: 'Hello.', errors: [] }); }
  finally { await session.close(); }
});

it('creates StoryData for the implicit entry when none exists (#141)', async () => {
  const model = workspace([[uri, ':: StoryTitle\nExample\n:: StoryVariables\n:: Start\nHello.\n:: StorySettings\nifid: 7E95B777-0E72-4603-AA57-049388D05756']]);
  const sources = renamed(model, { line: 3, character: 4 }, 'Opening');
  const compiled = await compile({ sources, ...compilerOptions });
  expect(compiled.diagnostics.filter(d => d.level === 'error')).toEqual([]);
  expect(compiled.story.twine2.start).toBe('Opening');
});

it('edits only top-level start values, preserving JSON spelling and CRLF coordinates (#141)', () => {
  const data = String.raw`{ "nested": {"start":"Start"}, "st\u0061rt" : "St\u0061rt", "start":"Start" }`;
  const model = workspace([
    [uri, ':: Start\r\nHello'],
    ['file:///data.tw', `:: StoryData\r\n${data}\r\n`],
  ]);
  const sources = renamed(model, { line: 0, character: 4 }, 'A "quote"');
  expect(sources.find(s => s.filename === 'file:///data.tw')!.content).toBe(
    `:: StoryData\r\n{ "nested": {"start":"Start"}, "st\\u0061rt" : "A \\"quote\\"", "start":"A \\"quote\\"" }\r\n`,
  );
});

it('leaves entry metadata unchanged when renaming an ordinary passage (#141)', async () => {
  const text = `${metadata},"start":"Start"}\n:: StoryVariables\n:: Start\n[[Other]]\n:: Other\nHello.`;
  const model = workspace([[uri, text]]);
  const sources = renamed(model, { line: 7, character: 4 }, 'Elsewhere');
  expect(sources[0].content).toContain('"start":"Start"');
  const compiled = await compile({ sources, ...compilerOptions });
  expect(compiled.diagnostics).toEqual([]);
});

it.each(['{bad', '[]', '{"start":null}', '{"start":"Start","start":null}'])('rejects unsafe entry metadata %s atomically (#141)', data => {
  const model = workspace([[uri, `:: StoryData\n${data}\n:: Start\nHello`]]);
  expect(() => renamed(model, { line: 2, character: 4 }, 'Opening')).toThrow(/Cannot preserve the entry passage/);
});

it('protects StoryContext from source and destination renames, preserving its runtime role (#142)', async () => {
  const text = `${metadata}}\n:: StoryVariables\n$hp = 10\n:: StoryContext\nHP: {$hp}\n:: Start\nHello\n:: Other\n[[StoryContext]]`;
  const model = workspace([[uri, text]]);
  for (const at of [{ line: 6, character: 5 }, { line: 11, character: 5 }]) {
    expect(prepareRename(uri, at, model)).toBeNull();
    expect(computeRename(uri, at, 'Stats', model).size).toBe(0);
  }
  expect(() => computeRename(uri, { line: 10, character: 4 }, 'StoryContext', model)).toThrow();
  const ordinary = workspace([[uri, ':: Ordinary\nHello']]);
  expect(() => computeRename(uri, { line: 0, character: 4 }, 'StoryContext', ordinary)).toThrow(/reserved passage name/);
  const compiled = await compile({ sources: [{ filename: uri, content: text }], ...compilerOptions });
  const session = await openPlaySession({ html: compiled.output });
  try { expect(await session.observe()).toMatchObject({ context: 'HP: 10', errors: [] }); }
  finally { await session.close(); }
});

function largeWorkspace() {
  const files: Array<[string, string]> = [[uri, ':: StoryVariables\n$x = 1\n:: Start\n{$x}']];
  for (let i = 0; i < 100; i++) files.push([`file:///p${i}.tw`, `:: P${i}\n` + 'Prose {$x} {if $x > 0}yes{/if} [[Start]]\n'.repeat(8)]);
  return workspace(files);
}

it('coalesces analysis and diagnostic publication across rapid edits (#143)', () => {
  vi.useFakeTimers();
  const model = largeWorkspace();
  const scan = vi.spyOn(model.variables, 'scanDocument');
  const discover = vi.spyOn(model.macros, 'setDiscoveredMacros');
  const sendDiagnostics = vi.fn();
  diagnosticsPlugin.initialize({ workspace: model, config: {}, connection: { sendDiagnostics } as unknown as Connection });
  for (let i = 0; i < 10; i++) model.documents.update(uri, `:: StoryVariables\n$y = ${i}\n:: Start\n{$y}`);
  expect(scan).not.toHaveBeenCalled();
  expect(discover).not.toHaveBeenCalled();
  expect(sendDiagnostics).not.toHaveBeenCalled();
  vi.advanceTimersByTime(199);
  expect(scan).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(discover).toHaveBeenCalledTimes(1);
  expect(scan).toHaveBeenCalledTimes(101);
  expect(sendDiagnostics).toHaveBeenCalledTimes(101);
  expect(model.variables.getUsages('y')).toHaveLength(1);
});

it('makes a feature query coherent before the debounce expires, then reuses the analysis (#143)', () => {
  vi.useFakeTimers();
  const model = largeWorkspace();
  const scan = vi.spyOn(model.variables, 'scanDocument');
  model.documents.update(uri, ':: StoryVariables\n$y = 1\n:: Start\n{$y}');
  model.documents.open('file:///widget.tw', ':: Widgets [widget]\n{widget "box"}{@children}{/widget}');
  model.documents.update('file:///p0.tw', ':: P0\n{box}{$y}{/box}');
  expect(scan).not.toHaveBeenCalled();
  expect(computeDiagnostics('file:///p0.tw', model).filter(d => d.severity === 'error')).toEqual([]);
  expect(model.variables.getUsages('y')).toHaveLength(2);
  expect(scan).toHaveBeenCalledTimes(102);
  vi.advanceTimersByTime(200);
  expect(scan).toHaveBeenCalledTimes(102);
  model.documents.close('file:///widget.tw');
  expect(computeDiagnostics('file:///p0.tw', model).map(d => d.code)).toContain('SP100');
  model.documents.update(uri, ':: Start\nHello');
  const count = scan.mock.calls.length;
  model.dispose();
  vi.advanceTimersByTime(200);
  expect(scan).toHaveBeenCalledTimes(count);
});
