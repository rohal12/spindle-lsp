import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from '@rohal12/twee-ts';
import { openPlaySession } from '@rohal12/spindle/play';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeRename } from '../../src/plugins/rename.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

it.each([
  ['a/z.tw', 'a.tw'],
  ['0.tw', '?.tw'],
  ['Z.tw', 'a.tw'],
])('keeps rename safe in compiler folder order (%s before %s)', async (early, later) => {
  const root = mkdtempSync(join(tmpdir(), 'spindle-declaration-order-'));
  const model = new WorkspaceModel();
  const files = new Map([
    [join(root, early), ':: StoryVariables\n$x = 1\n'],
    [join(root, later), ':: StoryVariables\n$x = 2\n'],
    [join(root, 'start.tw'), ':: StoryTitle\nExample\n:: StoryData\n{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"}\n:: Start\n{$x}\n'],
  ]);
  const write = () => {
    for (const [path, content] of files) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  };
  const render = async () => {
    const result = await compile({
      sources: [root],
      formatId: 'pkg',
      formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
      noRemote: true,
      useTweegoPath: false,
    });
    expect(result.diagnostics.filter(d => d.level === 'error')).toEqual([]);
    const session = await openPlaySession({ html: result.output, trusted: true });
    try {
      const observation = await session.observe();
      expect(observation.errors).toEqual([]);
      return observation.text;
    } finally { await session.close(); }
  };
  try {
    write();
    expect(await render()).toBe('2');
    model.initialize(new Map([...files].reverse().map(([path, text]) => [pathToFileURL(path).href, text])));
    const usageUri = pathToFileURL(join(root, 'start.tw')).href;
    const usage = files.get(join(root, 'start.tw'))!;
    const doc = TextDocument.create(usageUri, 'twee3', 1, usage);
    expect(computeDiagnostics(usageUri, model).filter(d => d.severity === 'error')).toEqual([]);
    const edits = computeRename(usageUri, doc.positionAt(usage.lastIndexOf('$x') + 1), 'changed', model);
    for (const [path, text] of files) {
      const uri = pathToFileURL(path).href;
      files.set(path, TextDocument.applyEdits(TextDocument.create(uri, 'twee3', 1, text), edits.get(uri) ?? []));
    }
    write();
    expect(await render()).toBe('2');
    expect(files.get(join(root, early))).toContain('$x = 1');
    expect(files.get(join(root, later))).toContain('$changed = 2');
  } finally {
    model.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
