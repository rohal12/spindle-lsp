/** Public transport regressions for the existing audit contract families. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { build } from 'esbuild';
import { buildDist, type DistBuild } from './support/dist-build.js';

let dist: DistBuild;
let directory: string;
beforeAll(() => { dist = buildDist(); });
afterAll(() => dist?.dispose());
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spindle-followup-entry-'));
  writeFileSync(join(directory, 'package.json'), '{}');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const run = (executable: string, args: string[]) => spawnSync(process.execPath, [executable, ...args], { cwd: directory, encoding: 'utf8', timeout: 10000 });

for (const version of ['package', '9.8.7-test']) {
  it(`CLI-REPORT/sarif-running-version/${version}`, async () => {
    let executable = dist.executable;
    if (version !== 'package') {
      executable = join(directory, 'alternate.mjs');
      await build({
        entryPoints: ['src/bin.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm', outfile: executable,
        external: ['prettier', '@rohal12/spindle/play', 'happy-dom', '@rohal12/twee-ts'],
        define: { SPINDLE_LSP_VERSION: JSON.stringify(version) },
        banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' },
      });
    }
    const reported = run(executable, ['--version']);
    expect(reported.status, reported.stderr).toBe(0);
    if (version !== 'package') expect(reported.stdout.trim()).toBe(version);
    for (const contents of [':: StoryVariables\n:: Start\nhello\n', ':: StoryVariables\n:: Start\n{notKnown}\n']) {
      writeFileSync(join(directory, 'story.tw'), contents);
      const result = run(executable, ['check', '--format', 'sarif', 'story.tw']);
      const hasErrors = contents.includes('notKnown');
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.version).toBe('2.1.0');
      expect(report.runs[0].tool.driver.version).toBe(reported.stdout.trim());
      expect(report.runs[0].results.length > 0).toBe(hasErrors);
      if (hasErrors) {
        expect(report.runs[0].tool.driver.rules.some((r: any) => r.id === 'SP100')).toBe(true);
        expect(report.runs[0].results[0].locations[0].physicalLocation.region.startLine).toBe(3);
      }
    }
  });
}

it('W74/HEADER/STRUCTURE/CONFIGURED-ARGS/PRETTIER-CONFIG over framed LSP', async () => {
  const text = ':: StoryVariables\n:: W [widget]\n{widget "button"}unused{/widget}\n{widget "hello"}Hi{/widget}\n:: X\\ \nbody\n:: Start\n{button "Run"}clicked{/button}\n{hello}\n[[X]]\n{greet "Alice" }\n{button "{switch 2}{case 1}x{default}y{default}z{/switch}"}clicked{/button}\n:: Code [script]\nconst a="hello";\n';
  const file = join(directory, 'story.tw');
  writeFileSync(file, text);
  writeFileSync(join(directory, 'macros.js'), 'Story.defineMacro({name:"greet",parameters:[{name:"who",type:"string",required:true},{name:"count",type:"number"}],render(){return null;}});');
  const config = join(directory, '.prettierrc.json');
  writeFileSync(config, '{"singleQuote":false}');
  const uri = pathToFileURL(file).toString();
  const source = TextDocument.create(uri, 'twee', 1, text);
  const textDocument = { uri };
  const proc = spawn(process.execPath, [dist.executable, '--stdio'], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.resume();
  const conn = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
  let diagnostics: any[] | undefined;
  conn.onNotification('textDocument/publishDiagnostics', params => { if (params.uri === uri) diagnostics = params.diagnostics; });
  conn.onRequest(() => null);
  conn.listen();
  const at = (fragment: string, delta = 0) => source.positionAt(text.indexOf(fragment) + delta);
  const request = async (method: string, params: any): Promise<any> => {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([conn.sendRequest(method, params), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} timed out`)), 5000); })]);
    } finally { clearTimeout(timer!); }
  };
  try {
    await request('initialize', { processId: null, rootUri: pathToFileURL(directory).toString(), capabilities: {} });
    await conn.sendNotification('initialized', {});
    await conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'twee', version: 1, text } });
    const declarationRefs = await request('textDocument/references', { textDocument, position: at('"hello"', 2), context: { includeDeclaration: true } });
    expect(declarationRefs).toHaveLength(2);
    const callRefs = await request('textDocument/references', { textDocument, position: at('{hello}', 2), context: { includeDeclaration: true } });
    expect(callRefs).toEqual(declarationRefs);
    const shadowed = await request('textDocument/rename', { textDocument, position: at('"button"', 2), newName: 'fresh' });
    expect(TextDocument.applyEdits(source, shadowed.changes[uri])).toBe(text.replace('"button"', '"fresh"'));
    const renamed = await request('textDocument/rename', { textDocument, position: at(':: X', 3), newName: 'Fresh' });
    const applied = TextDocument.applyEdits(source, renamed.changes[uri]);
    expect(applied).toContain(':: Fresh\n');
    expect(applied).toContain('[[Fresh]]');
    const signature = await request('textDocument/signatureHelp', { textDocument, position: at('{greet "Alice" }', '{greet "Alice" '.length) });
    expect(signature?.activeParameter).toBe(1);
    expect(signature.signatures[0].label).toBe('{greet who [count]}');
    const countLabel = signature.signatures[0].parameters[1].label;
    expect(signature.signatures[0].label.slice(...countLabel)).toBe('[count]');
    const format = async () => TextDocument.applyEdits(source, await request('textDocument/formatting', { textDocument, options: { tabSize: 2, insertSpaces: true } }));
    expect(await format()).toContain('const a = "hello";');
    writeFileSync(config, '{"singleQuote":true}');
    const changed = await format();
    expect(changed).toContain("const a = 'hello';");
    expect(changed).toContain(':: X\\ \n');
    await conn.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(config).toString(), type: 2 }] });
    expect(await format()).toBe(changed);
    rmSync(config);
    expect(await format()).toContain('const a = "hello";');
    const deadline = Date.now() + 4000;
    while (!diagnostics?.some(d => d.code === 'SP114') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(diagnostics?.filter(d => d.code === 'SP114'), JSON.stringify(diagnostics)).toHaveLength(1);
    expect(diagnostics?.filter(d => d.code === 'SP300')).toEqual([]);
  } finally { conn.dispose(); proc.kill(); }
});

it('STRUCTURE and PRETTIER-CONFIG changes through repeated MCP requests and CLI controls', async () => {
  const file = join(directory, 'story.tw');
  const text = ':: StoryVariables\n:: Start\n<span title="{option \'hi\'}">x</span>\n:: Code [script]\nconst a="hello";\n';
  writeFileSync(file, text);
  const config = join(directory, '.prettierrc.json');
  const client = new Client({ name: 'audit-followup', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [dist.executable, 'mcp'], cwd: directory, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const checked = await client.callTool({ name: 'spindle_check', arguments: { path: file } });
    expect(checked.isError).not.toBe(true);
    expect(JSON.stringify(checked.content)).toContain('SP107');
    const cli = run(dist.executable, ['check', '--format', 'json', file]);
    expect(cli.status, cli.stderr).toBe(1);
    expect(JSON.parse(cli.stdout).files.flatMap((f: any) => f.diagnostics).filter((d: any) => d.code === 'SP107')).toHaveLength(1);
    const format = async () => {
      writeFileSync(file, text);
      const result = await client.callTool({ name: 'spindle_format', arguments: { path: file } });
      expect(result.isError).not.toBe(true);
      return readFileSync(file, 'utf8');
    };
    expect(await format()).toContain('const a = "hello";');
    writeFileSync(config, '{"singleQuote":true}');
    expect(await format()).toContain("const a = 'hello';");
    writeFileSync(config, '{"singleQuote":false}');
    expect(await format()).toContain('const a = "hello";');
    rmSync(config);
    expect(await format()).toContain('const a = "hello";');
  } finally { await client.close(); }
});
