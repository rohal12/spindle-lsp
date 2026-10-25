import { afterEach, expect, it } from 'vitest';
import { compile, parseTwee } from '@rohal12/twee-ts';
import { fileURLToPath } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeCodeActions } from '../../src/plugins/code-actions.js';
import { computeRename, RenameError } from '../../src/plugins/rename.js';

const uri = 'file:///story.tw';
const models: WorkspaceModel[] = [];
function workspace(text: string) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text]]));
  return model;
}
afterEach(() => models.splice(0).forEach(model => model.dispose()));

for (const eol of ['\n', '\r\n', '\r']) {
  it.each([':: Broken [', '::', ':: Broken {', ':: Broken [tag] [extra]'])(
    `reports compiler-fatal headers: %s (EOL ${JSON.stringify(eol)}, #197)`, header => {
      const text = `\uFEFF:: StoryVariables\n:: Start\nhello 😀\n${header}\ntext\n:: Later\n{unknown}\n`.replaceAll('\n', eol);
      const errors = parseTwee(text).diagnostics.filter(d => d.level === 'error');
      expect(errors).toHaveLength(1);
      const model = workspace(text);
      const diagnostics = computeDiagnostics(uri, model);
      expect(diagnostics.filter(d => d.code === 'SP002')).toEqual([{
        code: 'SP002', severity: 'error', source: 'spindle', message: errors[0].message,
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: header.length } },
      }]);
      // The editor still recovers later passages and their diagnostics.
      expect(model.passages.getPassage('Later')).toBeDefined();
      expect(diagnostics.some(d => d.code === 'SP100' && d.range.start.line === 6)).toBe(true);
      model.documents.update(uri, text.replace(header + eol, ':: Fixed' + eol));
      expect(computeDiagnostics(uri, model).some(d => d.code === 'SP002')).toBe(false);
    },
  );
}

it('reports a malformed header even when no passage could be indexed (#197)', () => {
  const model = workspace('::\n');
  expect(model.passages.getAllPassages()).toEqual([]);
  expect(computeDiagnostics(uri, model)).toMatchObject([{ code: 'SP002', severity: 'error' }]);
});

it('keeps the compiler behavior for escaped headers and optional invalid metadata JSON (#197)', () => {
  for (const header of [':: StoryD\\ata', ':: A\\[B', ':: A {oops}']) {
    const text = `:: StoryVariables\n${header}\nhello\n`;
    expect(parseTwee(text).diagnostics.filter(d => d.level === 'error')).toEqual([]);
    expect(computeDiagnostics(uri, workspace(text)).filter(d => d.severity === 'error')).toEqual([]);
  }
});

const metadata = ':: StoryTitle\nExample\n:: StoryData\n{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"}\n';
async function compiled(text: string) {
  return compile({
    sources: [{ filename: uri, content: text }], formatId: 'pkg',
    formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
    noRemote: true, useTweegoPath: false,
  });
}

it.each(['\u0085Hall', 'Hall\u0085', ' Hall', 'Hall ', '\tHall', 'Hall\t', '', 'two\nlines'])(
  'rejects unrepresentable rename and creation identities %j (#198)', async name => {
    const text = `${metadata}:: StoryVariables\n:: Start\nhello\n`;
    expect((await compiled(text)).diagnostics.filter(d => d.level === 'error')).toEqual([]);
    const model = workspace(text);
    const doc = TextDocument.create(uri, 'twee', 1, text);
    const at = doc.positionAt(text.indexOf(':: Start') + 3);
    expect(() => computeRename(uri, at, name, model)).toThrow(RenameError);
    expect(model.documents.getText(uri)).toBe(text);
    const broken = `${text}{goto ${JSON.stringify(name)}}\n`;
    model.documents.update(uri, broken);
    const diags = computeDiagnostics(uri, model).filter(d => d.code === 'SP300');
    // Empty destinations are ignored by the runtime; other names are unknown.
    if (name) expect(diags).toHaveLength(1);
    expect(computeCodeActions(uri, diags, model).filter(a => a.title.startsWith('Create passage'))).toEqual([]);
  },
);

it.each(['Hall', 'A[B]{C}\\D', 'A\u0085B', '\uFEFFHall', 'Hall\uFEFF'])(
  'applies representable rename and creation identities %j without changing compiler entry resolution (#198)', async name => {
    const text = `${metadata}:: StoryVariables\n:: Start\nhello\n`;
    const doc = TextDocument.create(uri, 'twee', 1, text);
    const model = workspace(text);
    const edits = computeRename(uri, doc.positionAt(text.indexOf(':: Start') + 3), name, model);
    const renamed = TextDocument.applyEdits(doc, edits.get(uri)!);
    const result = await compiled(renamed);
    expect(result.diagnostics.filter(d => d.level === 'error')).toEqual([]);
    expect(result.story.twine2.start).toBe(name);
    expect(parseTwee(renamed).passages.some(p => p.name === name)).toBe(true);

    const broken = `${text}{goto ${JSON.stringify(name)}}\n`;
    model.documents.update(uri, broken);
    const actions = computeCodeActions(uri, computeDiagnostics(uri, model).filter(d => d.code === 'SP300'), model);
    const create = actions.find(a => a.title.startsWith('Create passage'))!;
    expect(create).toBeDefined();
    const fixed = TextDocument.applyEdits(TextDocument.create(uri, 'twee', 1, broken), create.edits);
    expect(parseTwee(fixed).passages.some(p => p.name === name)).toBe(true);
    model.documents.update(uri, fixed);
    expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP300')).toEqual([]);
    expect((await compiled(fixed)).diagnostics.filter(d => d.level === 'error')).toEqual([]);
  },
);
