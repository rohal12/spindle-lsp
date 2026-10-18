import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildDist, type DistBuild } from './support/dist-build.js';

let dist: DistBuild;
let directory: string;
beforeAll(() => { dist = buildDist(); }, 60_000);
afterAll(() => dist?.dispose());
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spindle-audit-fixes-'));
  writeFileSync(join(directory, 'package.json'), '{}');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const environment = (trusted = false) => ({
  ...process.env, SPINDLE_LSP_TRUSTED_FORMAT: trusted ? '1' : '', SPINDLE_LSP_TRUSTED_PLAY: '',
}) as Record<string, string>;
const file = () => join(directory, 'story.tw');
const uri = () => pathToFileURL(file()).href;

async function withLsp(text: string, trusted: boolean, run: (conn: MessageConnection) => Promise<void>): Promise<void> {
  const proc = spawn(process.execPath, [dist.executable, '--stdio'], {
    cwd: directory, env: environment(trusted), stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stderr.resume();
  const conn = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
  conn.onRequest(() => null);
  conn.listen();
  try {
    await conn.sendRequest('initialize', { processId: null, rootUri: pathToFileURL(directory).href, capabilities: {} });
    await conn.sendNotification('initialized', {});
    await conn.sendNotification('textDocument/didOpen', { textDocument: { uri: uri(), languageId: 'twee', version: 1, text } });
    await run(conn);
  } finally { conn.dispose(); proc.kill(); }
}

async function formattedBy(entrypoint: string, source: string, trusted = false): Promise<string> {
  writeFileSync(file(), source);
  if (entrypoint === 'CLI') {
    const run = (...args: string[]) => spawnSync(process.execPath, [dist.executable, 'format', ...args, file()], {
      cwd: directory, env: environment(trusted), encoding: 'utf8', timeout: 10000,
    });
    const check = run('--check');
    expect(check.status, check.stderr).toBe(1);
    expect(readFileSync(file(), 'utf8')).toBe(source);
    const format = run();
    expect(format.status, format.stderr).toBe(0);
    const output = readFileSync(file(), 'utf8');
    const recheck = run('--check');
    expect(recheck.status, recheck.stderr).toBe(0);
    expect(readFileSync(file(), 'utf8')).toBe(output);
    return output;
  }
  if (entrypoint === 'MCP') {
    const client = new Client({ name: 'audit-fixes', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [dist.executable, 'mcp'], cwd: directory, env: environment(trusted), stderr: 'ignore',
    });
    try {
      await client.connect(transport);
      const before = await client.callTool({ name: 'spindle_format_check', arguments: { path: file() } });
      expect(before.isError).not.toBe(true);
      expect(JSON.stringify(before.content)).toContain('needsFormatting');
      expect(readFileSync(file(), 'utf8')).toBe(source);
      const result = await client.callTool({ name: 'spindle_format', arguments: { path: file() } });
      expect(result.isError).not.toBe(true);
      const output = readFileSync(file(), 'utf8');
      const after = await client.callTool({ name: 'spindle_format_check', arguments: { path: file() } });
      expect(after.isError).not.toBe(true);
      const report = JSON.parse((after.content as { text: string }[])[0].text);
      expect(report.needsFormatting).toEqual([]);
      expect(report.alreadyFormatted).toEqual(['story.tw']);
      expect(readFileSync(file(), 'utf8')).toBe(output);
      return output;
    } finally { await client.close(); }
  }
  let output = '';
  await withLsp(source, trusted, async conn => {
    const params = { textDocument: { uri: uri() }, options: { tabSize: 2, insertSpaces: true } };
    const edits = await conn.sendRequest('textDocument/formatting', params);
    expect(edits).toHaveLength(1);
    output = TextDocument.applyEdits(TextDocument.create(uri(), 'twee', 1, source), edits as never);
    await conn.sendNotification('textDocument/didChange', { textDocument: { uri: uri(), version: 2 }, contentChanges: [{ text: output }] });
    expect(await conn.sendRequest('textDocument/formatting', params)).toEqual([]);
  });
  return output;
}

for (const entrypoint of ['CLI', 'MCP', 'LSP']) {
  for (const configKind of ['executable', 'plugin', 'shared']) {
    it(`${entrypoint}: untrusted ${configKind} config cannot overwrite a host sentinel (#128)`, async () => {
      const sentinel = join(directory, 'host-sentinel');
      writeFileSync(sentinel, 'private host data');
      const code = `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed'); module.exports = { singleQuote: true };`;
      if (configKind === 'executable') writeFileSync(join(directory, '.prettierrc.cjs'), code);
      else {
        writeFileSync(join(directory, 'project-code.cjs'), code);
        writeFileSync(join(directory, '.prettierrc.json'), JSON.stringify(configKind === 'shared'
          ? './project-code.cjs' : { singleQuote: true, plugins: ['./project-code.cjs'] }));
      }
      const output = await formattedBy(entrypoint, ':: Code [script]\nconst x="hello";\n');
      expect(readFileSync(sentinel, 'utf8')).toBe('private host data');
      expect(output).toContain(configKind === 'plugin' ? "const x = 'hello';" : 'const x = "hello";');
    });
  }

  it(`${entrypoint}: host opt-in allows an executable Prettier config (#128)`, async () => {
    const marker = join(directory, 'marker');
    writeFileSync(join(directory, '.prettierrc.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); module.exports = { singleQuote: true };`);
    const output = await formattedBy(entrypoint, ':: Code [script]\nconst x="hello";\n', true);
    expect(output).toContain("const x = 'hello';");
    expect(readFileSync(marker, 'utf8')).toBe('executed');
  });

  it.each(['\n', '\r\n'])(`${entrypoint}: repeated formatting preserves %j with CRLF config (#129)`, async eol => {
    writeFileSync(join(directory, '.prettierrc.json'), '{"endOfLine":"crlf"}');
    const output = await formattedBy(entrypoint, ':: Code [script]\nconst x=1;\nif(x){console.log(x)}\n'.replaceAll('\n', eol));
    expect(output).toBe(':: Code [script]\nconst x = 1;\nif (x) {\n  console.log(x);\n}\n'.replaceAll('\n', eol));
  });
}

it('LSP completion replaces underscore names and code lenses count executable uses (#130–132)', async () => {
  const source = [
    ':: StoryVariables', '$x = 1', '$x = 2', ':: Widgets [widget]',
    '{widget "my_widget"}{@children}{/widget}', ':: room_hall', 'Hello.',
    ':: Start', '{set _hello=1}', '{$x}', '{my_widget}one{/my_widget}',
    '[[room_hall]]', '{my_widget}two{/my_widget}', '',
  ].join('\n');
  writeFileSync(file(), source);
  await withLsp(source, false, async conn => {
    const textDocument = { uri: uri() };
    for (const [line, character, label] of [[11, 7, 'room_hall'], [12, 4, 'my_widget']] as const) {
      const items: any = await conn.sendRequest('textDocument/completion', { textDocument, position: { line, character } });
      const chosen = items.find((item: any) => item.label === label);
      expect(chosen).toBeDefined();
      expect(TextDocument.applyEdits(TextDocument.create(uri(), 'twee', 1, source), [chosen.textEdit])).toBe(source);
    }
    const lenses: any = await conn.sendRequest('textDocument/codeLens', { textDocument });
    expect(lenses.filter((lens: any) => [1, 2].includes(lens.range.start.line)).map((lens: any) => lens.command.title))
      .toEqual(['1 usage', '1 usage']);
    expect(lenses.find((lens: any) => lens.range.start.line === 4).command.title).toBe('2 usages');
    const refs: any = await conn.sendRequest('textDocument/references', {
      textDocument, position: { line: 4, character: 11 }, context: { includeDeclaration: true },
    });
    expect(refs).toHaveLength(5);
    const renamed: any = await conn.sendRequest('textDocument/rename', {
      textDocument, position: { line: 4, character: 11 }, newName: 'card',
    });
    const applied = TextDocument.applyEdits(TextDocument.create(uri(), 'twee', 1, source), renamed.changes[uri()]);
    expect(applied).toContain('{card}one{/card}');
    expect(applied).toContain('{card}two{/card}');
  });
});
