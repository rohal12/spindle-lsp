/**
 * Contract #82: every position the server returns is in the client's own
 * coordinates, including when the client's text starts with a U+FEFF byte
 * order mark. Driven through the built executable over framed JSON-RPC; the
 * expected values are written out, not computed by the code under test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import {
  createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { buildDist, type DistBuild } from './support/dist-build.js';

const BOM = '﻿';
const NAMESPACE = 8; // index of 'namespace' in the token legend

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface Edit { range: Range; newText: string }

const range = (line: number, from: number, to: number): Range => ({
  start: { line, character: from }, end: { line, character: to },
});
const apply = (uri: string, text: string, edits: Edit[]) =>
  TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, text), edits);

let dist: DistBuild;
beforeAll(() => { dist = buildDist(); }, 60_000);
afterAll(() => dist?.dispose());

let directory: string;
let conn: MessageConnection;
let kill: () => void;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'spindle-bom-'));
  writeFileSync(join(directory, 'seed.txt'), '');
});
afterEach(async () => {
  try { await conn?.sendRequest('shutdown'); await conn?.sendNotification('exit'); } catch { /* gone */ }
  conn?.dispose();
  kill?.();
  rmSync(directory, { recursive: true, force: true });
});

async function start(): Promise<void> {
  const proc = spawn(process.execPath, [dist.executable], { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.resume();
  kill = () => proc.kill();
  conn = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
  conn.onRequest(() => null);
  conn.listen();
  await conn.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(directory).toString(), capabilities: {} });
  await conn.sendNotification('initialized', {});
}

const open = (uri: string, text: string, version = 1) =>
  conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'twee', version, text } });

const prepare = (uri: string, line: number, character: number) =>
  conn.sendRequest('textDocument/prepareRename', { textDocument: { uri }, position: { line, character } }) as
    Promise<{ range: Range; placeholder: string } | null>;

const rename = async (uri: string, line: number, character: number, newName: string) =>
  (await conn.sendRequest('textDocument/rename', { textDocument: { uri }, position: { line, character }, newName }) as
    { changes: Record<string, Edit[]> } | null)?.changes ?? {};

/** The rename an editor would apply to its own buffer for the header at line 0, character 5. */
async function renameFirstHeader(uri: string, text: string): Promise<string> {
  const changes = await rename(uri, 0, 5, 'New');
  return apply(uri, text, changes[uri]);
}

for (const [label, prefix] of [['BOM', BOM], ['no BOM (control)', '']] as const) {
  const shift = prefix.length;
  const source = `${prefix}:: Old\nhi\n:: StoryVariables\n:: Start\n[[Old]]`;

  describe(`#82 ${label}: client coordinates over framed JSON-RPC`, () => {
    let uri: string;
    beforeEach(async () => {
      await start();
      uri = pathToFileURL(join(directory, 'story.tw')).toString();
    });

    it('didOpen: prepareRename on the first header offers exactly the name', async () => {
      await open(uri, source);
      const prep = await prepare(uri, 0, 5);
      expect(prep).toEqual({ range: range(0, 3 + shift, 6 + shift), placeholder: 'Old' });
      expect(source.slice(3 + shift, 6 + shift)).toBe('Old');
    });

    it('didOpen: renaming the first header edits the client buffer and keeps the BOM and the whole header', async () => {
      await open(uri, source);
      const after = await renameFirstHeader(uri, source);
      expect(after).toBe(`${prefix}:: New\nhi\n:: StoryVariables\n:: Start\n[[New]]`);
    });

    it('didChange (full text): coordinates follow the text the client last sent', async () => {
      await open(uri, ':: Other\n');
      await conn.sendNotification('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: source }] });
      expect(await renameFirstHeader(uri, source)).toBe(`${prefix}:: New\nhi\n:: StoryVariables\n:: Start\n[[New]]`);
    });

    it('didChange (incremental): the BOM added to or removed from the first line moves the columns with it', async () => {
      const other = source.startsWith(BOM) ? source.slice(1) : BOM + source;
      await open(uri, other);
      const change = other.startsWith(BOM)
        ? { range: range(0, 0, 1), text: '' }
        : { range: range(0, 0, 0), text: BOM };
      await conn.sendNotification('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [change] });
      expect(await prepare(uri, 0, 5)).toEqual({ range: range(0, 3 + shift, 6 + shift), placeholder: 'Old' });
      expect(await renameFirstHeader(uri, source)).toBe(`${prefix}:: New\nhi\n:: StoryVariables\n:: Start\n[[New]]`);
    });

    it('definition from a reference spans the first header line, up to the end of the name', async () => {
      await open(uri, source);
      const def = await conn.sendRequest('textDocument/definition', { textDocument: { uri }, position: { line: 4, character: 3 } }) as
        { uri: string; range: Range } | Array<{ uri: string; range: Range }>;
      const found = Array.isArray(def) ? def : [def];
      expect(found).toEqual([{ uri, range: range(0, 0, 6 + shift) }]);
    });

    it('semantic tokens on the first line: `::` and the name sit where they are in the buffer', async () => {
      await open(uri, source);
      const tokens = await conn.sendRequest('textDocument/semanticTokens/full', { textDocument: { uri } }) as { data: number[] };
      const first = tokens.data.slice(0, 10);
      // [deltaLine, deltaStart, length, type, modifiers] twice: `::`, then the name
      expect(first.slice(0, 4)).toEqual([0, shift, 2, NAMESPACE]);
      expect(first.slice(5, 9)).toEqual([0, 3, 3, NAMESPACE]);
    });

    it('a target loaded from disk (never opened) is renamed in its own file coordinates', async () => {
      const target = `${prefix}:: Old\nhi\n`;
      const targetUri = pathToFileURL(join(directory, 'target.tw')).toString();
      const files = {
        'target.tw': target,
        'base.tw': `:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"Spindle","format-version":"0.45.1"}\n\n:: StoryVariables\n:: Start\n`,
      };
      for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
      await open(uri, `:: Elsewhere\n[[Old]]\n`);
      // the workspace scan runs after initialized; wait until the target is known
      const deadline = Date.now() + 8000;
      let changes: Record<string, Edit[]> = {};
      while (Date.now() < deadline) {
        changes = await rename(uri, 1, 3, 'New');
        if (changes[targetUri]) break;
        await new Promise(r => setTimeout(r, 100));
      }
      expect(changes[targetUri], 'the disk-loaded target is part of the rename').toBeDefined();
      expect(apply(targetUri, target, changes[targetUri])).toBe(`${prefix}:: New\nhi\n`);
      expect(changes[targetUri][0].range).toEqual(range(0, 3 + shift, 6 + shift));
    });
  });
}
