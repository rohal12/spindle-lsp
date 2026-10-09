/**
 * Contract K66-entry (#66): formatting through the real entrypoints of the
 * built executable (LSP over framed JSON-RPC, `format` CLI, MCP tools)
 * preserves multiline macro payloads and the document's line endings.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
  createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tokenize } from '../helpers/tooling.js';
import { buildDist, type DistBuild } from './support/dist-build.js';

/** What the runtime executes: compiler-normalized newlines, macro payloads. */
function payloads(text: string): string[] {
  return tokenize(text.replaceAll('\r\n', '\n'))
    .filter(t => t.type === 'macro')
    .map(t => `${t.isClose ? '/' : ''}${t.name} ${t.rawArgs}`);
}

const PASSAGE = [
  ':: Start   ',
  '{if $x}',
  'prose   ',
  '{set $a = `a',
  '  b   ',
  'c`}',
  '{/if}',
  '<div>',
  '<span>{print `x ${ {a: 1}.a }',
  '  y   z`}</span>',
  '</div>',
  '{set $s = "{"}',
  'stray   brace   span }',
  '',
].join('\n');

/** The fixture with the given line endings. */
const withEol = (text: string, eol: string) => text.replaceAll('\n', eol);

let dist: DistBuild;
beforeAll(() => { dist = buildDist(); }, 60_000);
afterAll(() => dist?.dispose());

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'spindle-format-entry-')); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function expectFormatted(source: string, output: string, eol: string): void {
  expect(payloads(output), 'macro payloads').toEqual(payloads(source));
  // One line-ending style throughout, the source's own
  expect(output.replaceAll(eol, '')).not.toMatch(/[\r\n]/);
  expect(output.endsWith(eol)).toBe(true);
  // Something was formatted: the header lost its trailing spaces
  expect(output.startsWith(`:: Start${eol}`)).toBe(true);
}

for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n']] as const) {
  describe(`K66-entry ${label}: real entrypoints of the built executable`, () => {
    const source = withEol(PASSAGE, eol);

    it(`K66-entry-cli ${label}: \`spindle-lsp format\` rewrites the file, then --check passes`, () => {
      const file = join(directory, 'story.tw');
      writeFileSync(file, source);
      const check = spawnSync(process.execPath, [dist.executable, 'format', '--check', file], { encoding: 'utf8' });
      expect(check.status).toBe(1);
      expect(check.stdout).toContain('would be reformatted');
      expect(readFileSync(file, 'utf8')).toBe(source); // --check never writes

      const run = spawnSync(process.execPath, [dist.executable, 'format', file], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      const output = readFileSync(file, 'utf8');
      expectFormatted(source, output, eol);

      const recheck = spawnSync(process.execPath, [dist.executable, 'format', '--check', file], { encoding: 'utf8' });
      expect(recheck.status).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe(output);
    });

    it(`K66-entry-mcp ${label}: spindle_format and spindle_format_check tools`, async () => {
      const file = join(directory, 'story.tw');
      writeFileSync(file, source);
      const client = new Client({ name: 'test', version: '0' });
      const transport = new StdioClientTransport({
        command: process.execPath, args: [dist.executable, 'mcp'], cwd: directory,
        env: { ...process.env } as Record<string, string>, stderr: 'ignore',
      });
      await client.connect(transport);
      try {
        const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0].text);
        const before = JSON.parse(text(await client.callTool({ name: 'spindle_format_check', arguments: { path: '*.tw' } })));
        expect(before).toEqual({ needsFormatting: ['story.tw'], alreadyFormatted: [] });
        expect(readFileSync(file, 'utf8')).toBe(source);

        const result = JSON.parse(text(await client.callTool({ name: 'spindle_format', arguments: { path: '*.tw' } })));
        expect(result).toEqual({ formatted: 1, unchanged: 0, files: ['story.tw'] });
        const output = readFileSync(file, 'utf8');
        expectFormatted(source, output, eol);

        const after = JSON.parse(text(await client.callTool({ name: 'spindle_format_check', arguments: { path: '*.tw' } })));
        expect(after).toEqual({ needsFormatting: [], alreadyFormatted: ['story.tw'] });
      } finally {
        await client.close();
      }
    });

    describe('LSP textDocument/formatting over framed JSON-RPC', () => {
      let conn: MessageConnection;
      let kill: () => void;
      let uri: string;
      beforeEach(async () => {
        const proc = spawn(process.execPath, [dist.executable], { stdio: ['pipe', 'pipe', 'pipe'] });
        proc.stderr.resume();
        kill = () => proc.kill();
        conn = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
        conn.onRequest(() => null);
        conn.listen();
        await conn.sendRequest('initialize', {
          processId: process.pid, rootUri: pathToFileURL(directory).toString(), capabilities: {},
        });
        await conn.sendNotification('initialized', {});
        uri = pathToFileURL(join(directory, 'story.tw')).toString();
        await conn.sendNotification('textDocument/didOpen', {
          textDocument: { uri, languageId: 'twee', version: 1, text: source },
        });
      });
      afterEach(async () => {
        try { await conn.sendRequest('shutdown'); await conn.sendNotification('exit'); } catch { /* gone */ }
        conn.dispose();
        kill();
      });

      for (const method of ['textDocument/formatting', 'textDocument/rangeFormatting'] as const) {
        it(`K66-entry-lsp ${label}: ${method} edit yields formatted text with intact payloads`, async () => {
          const params = {
            textDocument: { uri },
            options: { tabSize: 2, insertSpaces: true },
            ...(method === 'textDocument/rangeFormatting'
              ? { range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } } } : {}),
          };
          const edits = await conn.sendRequest(method, params) as { range: unknown; newText: string }[];
          expect(edits).toHaveLength(1);
          const doc = TextDocument.create(uri, 'twee', 1, source);
          const output = TextDocument.applyEdits(doc, edits as never);
          expectFormatted(source, output, eol);

          // Idempotent: formatting the formatted document proposes nothing
          await conn.sendNotification('textDocument/didChange', {
            textDocument: { uri, version: 2 }, contentChanges: [{ text: output }],
          });
          expect(await conn.sendRequest(method, params)).toEqual([]);
        });
      }
    });
  });
}
