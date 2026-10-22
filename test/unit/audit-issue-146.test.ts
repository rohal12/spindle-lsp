import { afterEach, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { compile } from '@rohal12/twee-ts';
import { openPlaySession } from '@rohal12/spindle/play';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeRename } from '../../src/plugins/rename.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { getSignatureHelp } from '../../src/plugins/signature.js';

const models: WorkspaceModel[] = [];
const metadata = ':: StoryTitle\nExample\n:: StoryData\n{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"}\n:: StoryVariables\n$x = 7\n';
const init = ':: StoryInit\n{widget "caption" @v}INIT:{@v}{/widget}\n';
const tagged = ':: Widgets [widget]\n{widget "CAPTION" @obsolete:markup @extra}{@obsolete}{@children}{/widget}\n';
const call = ':: Start\n{caption "{$x}"}\n';

function workspace(files: Array<[string, string]>) {
  const model = new WorkspaceModel();
  model.initialize(new Map(files));
  models.push(model);
  return model;
}
afterEach(() => models.splice(0).forEach(model => model.dispose()));

for (const initFirst of [true, false]) {
  for (const reverse of [false, true]) {
    for (const eol of ['\n', '\r\n']) {
      it(`uses StoryInit across source/ingestion/EOL permutations (${initFirst}, ${reverse}, ${JSON.stringify(eol)}) (#146)`, async () => {
        const initUri = `file:///${initFirst ? 'a' : 'z'}.tw`;
        const taggedUri = `file:///${initFirst ? 'z' : 'a'}.tw`;
        const files: Array<[string, string]> = [
          [initUri, (metadata + init + call).replaceAll('\n', eol)],
          [taggedUri, tagged.replaceAll('\n', eol)],
        ];
        if (reverse) files.reverse();
        const model = workspace(files);
        const widget = model.widgets.getWidget('CAPTION');
        expect(widget).toMatchObject({ uri: initUri, params: ['@v'], block: false });
        expect(widget?.nameRange).toEqual({ start: { line: 7, character: 9 }, end: { line: 7, character: 16 } });
        expect(model.variables.getUsages('x')).toEqual([]);
        expect(model.isContainer('caption')).toBe(false);
        expect(computeDiagnostics(initUri, model).filter(d => d.severity === 'error')).toEqual([]);
        expect(computeDiagnostics(initUri, model).filter(d => d.code === 'SP301')).toEqual([]);
        expect(getDefinition(initUri, { line: 9, character: 3 }, model)).toMatchObject({ uri: initUri, range: widget!.range });
        expect(getSignatureHelp(initUri, { line: 9, character: 11 }, model)?.signatures[0].label).toBe('{caption @v}');

        const edits = computeRename(initUri, { line: 5, character: 1 }, 'y', model);
        const renamed: Array<[string, string]> = files.map(([uri, content]) => [
          uri, TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, content), edits.get(uri) ?? []),
        ]);
        expect(renamed.find(([uri]) => uri === initUri)?.[1]).toContain('{caption "{$x}"}');
        const rebuilt = workspace(renamed);
        expect(computeDiagnostics(initUri, rebuilt).filter(d => d.severity === 'error')).toEqual([]);
        for (const sources of [files, renamed]) {
          const compiled = await compile({
            sources: sources.map(([filename, content]) => ({ filename, content })),
            formatId: 'pkg', formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
            noRemote: true, useTweegoPath: false,
          });
          expect(compiled.diagnostics).toEqual([]);
          const session = await openPlaySession({ html: compiled.output, trusted: true });
          try { expect(await session.observe()).toMatchObject({ text: 'INIT:{$x}', errors: [] }); }
          finally { await session.close(); }
        }

        // Unsaved changes must replace the effective argument roles immediately.
        model.documents.update(initUri, files.find(([uri]) => uri === initUri)![1].replace('@v}', '@v:markup}'));
        expect(model.variables.getUsages('x')).toHaveLength(1);
        model.documents.update(initUri, files.find(([uri]) => uri === initUri)![1]);
        expect(model.variables.getUsages('x')).toEqual([]);
      });
    }
  }
}

it.each([true, false])('applies StoryInit precedence within one document (first: %s) (#146)', first => {
  const uri = 'file:///story.tw';
  const text = metadata + (first ? init + tagged : tagged + init) + call;
  const model = workspace([[uri, text]]);
  expect(model.widgets.getWidget('caption')?.params).toEqual(['@v']);
  expect(model.variables.getUsages('x')).toEqual([]);
  expect(computeDiagnostics(uri, model).filter(d => d.severity === 'error' || d.code === 'SP301')).toEqual([]);
});

it('keeps closed definitions and maps duplicate passage names to the right document (#146)', () => {
  const a = 'file:///a.tw';
  const z = 'file:///z.tw';
  const closed = ':: Shared [widget]\n{widget "caption" @kept}{@kept}{/widget}\n';
  const incomplete = ':: Shared [widget]\n{widget "CAPTION" @incomplete @extra}{@children}\n';
  const model = workspace([[z, incomplete], [a, metadata + closed + call]]);
  expect(model.widgets.getWidget('caption')).toMatchObject({ uri: a, params: ['@kept'], block: false });
  expect(computeDiagnostics(a, model).filter(d => d.code === 'SP301')).toEqual([]);
  model.documents.update(z, incomplete + '{/widget}');
  expect(model.widgets.getWidget('caption')).toMatchObject({ uri: z, params: ['@incomplete', '@extra'], block: true });
  expect(computeDiagnostics(a, model).filter(d => d.code === 'SP301')).toHaveLength(1);
  model.documents.update(z, '');
  expect(model.widgets.getWidget('caption')?.uri).toBe(a);
  expect(computeDiagnostics(a, model).filter(d => d.code === 'SP301')).toEqual([]);
});

it('reports an unused widget only at its effective definition (#146)', () => {
  const a = 'file:///a.tw';
  const z = 'file:///z.tw';
  const model = workspace([[a, metadata + init + ':: Start\nHello'], [z, tagged]]);
  expect(computeDiagnostics(a, model).filter(d => d.code === 'SP303')).toHaveLength(1);
  expect(computeDiagnostics(z, model).filter(d => d.code === 'SP303')).toEqual([]);
});
