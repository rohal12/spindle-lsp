/** Public transport coverage for the ticket-owned repair tables. */
import { expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { builtinMacros, passagePieces } from '@rohal12/spindle/tooling';
import type { Dims } from './harness.js';

type Cell = (id: string, dims: Dims, run: () => void | Promise<void>) => void;
function project(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'spindle-repair-'));
  for (const [name, content] of Object.entries({ 'package.json': '{}', ...files })) {
    const file = join(directory, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
  return { directory, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}
const dims = (contract: string, consumer: string): Dims => ({ role: 'ordinary/declarations', context: contract, spelling: 'ticket reproduction/control', boundary: 'LF', state: 'public stdio/disk/reload', consumer });

export function registerRepairEntrypoints(cell: Cell, executable: () => string): void {
  // #96: fatal heap exhaustion needs a bounded subprocess, never the vitest worker.
  for (const [indent, width] of [['    ', 2], ['    ', 4], ['    ', 5], ['    ', 80], ['\t', 2], [' '.repeat(84), 80], ['', 2]] as const) {
    for (const wrapper of ['plain', 'nested-macro', 'nested-list']) {
    cell(`I/entry-cli/FORMAT-WRAP/${wrapper}/indent-${indent.length}-width-${width}-${indent.includes('\t') ? 'tab' : 'space'}`, dims('FORMAT-WRAP', 'bundled CLI bounded memory/termination'), () => {
      const line = `${indent}- a long list item many words`;
      const body = wrapper === 'nested-macro' ? `{if true}\n${line}\n{/if}` : wrapper === 'nested-list' ? `- outer\n${line}` : line;
      const fixture = project({ 'story.tw': `:: StoryVariables\n:: Start\n${body}\n` });
      try {
        const output = spawnSync(process.execPath, ['--max-old-space-size=64', executable(), 'format', '--check', '--max-line-length', String(width), 'story.tw'], { cwd: fixture.directory, encoding: 'utf8', timeout: 8000 });
        expect(output.error).toBeUndefined();
        expect(output.signal).toBeNull();
        expect([0, 1]).toContain(output.status);
        expect(output.stderr).not.toMatch(/heap|RangeError|Invalid array length/);
      } finally { fixture.dispose(); }
    });
    }
  }

  // #100/#99: literal directories (also glob characters), exact files and globs.
  for (const path of ['story', 'story/', 'story/**/*.tw', 'story/broken.tw', 'story[1]', 'empty']) {
    cell(`I/entry-cli/MCP-PATH/${path}`, dims('MCP-PATH', 'all three tools over MCP stdio'), async () => {
      const text = ':: StoryVariables\n:: Start\n{if true}\n{definitelyUnknown}\n{/if}';
      const fixture = project({ 'story/broken.tw': text, 'story[1]/broken.twee': text, 'spindle.config.yaml': 'macros:\n  foo:\n  if:\n' });
      mkdirSync(join(fixture.directory, 'empty'));
      const transport = new StdioClientTransport({ command: process.execPath, args: [executable(), 'mcp'], cwd: fixture.directory, stderr: 'pipe' });
      const client = new Client({ name: 'repair-contract', version: '1' });
      try {
        await client.connect(transport);
        const call = async (name: string): Promise<any> => {
          const result = await client.callTool({ name, arguments: { path } }, undefined, { timeout: 8000 });
          expect(result.isError).not.toBe(true);
          const content = result.content as Array<{ type: string; text: string }>;
          return JSON.parse(content[0].text);
        };
        const check = await call('spindle_check');
        expect(check.filter((d: any) => d.code === 'SP100')).toHaveLength(path === 'empty' ? 0 : 1);
        const formatting = await call('spindle_format_check');
        expect(formatting.needsFormatting).toHaveLength(path === 'empty' ? 0 : 1);
        const formatted = await call('spindle_format');
        expect(formatted.formatted).toBe(path === 'empty' ? 0 : 1);
        if (path !== 'empty') {
          const file = path.startsWith('story[1]') ? 'story[1]/broken.twee' : 'story/broken.tw';
          expect(readFileSync(join(fixture.directory, file), 'utf8')).toContain('  {definitelyUnknown}');
          expect((await call('spindle_format_check')).needsFormatting).toEqual([]);
        }
      } finally { await client.close(); fixture.dispose(); }
    });
  }

  for (const format of ['yaml', 'json']) {
    cell(`I/entry-cli/CONFIG-ENTRY/${format}`, dims('CONFIG-ENTRY', 'bundled check null/wrong-shape configs'), () => {
      const fixture = project({ 'story.tw': ':: StoryVariables\n:: Start\n{foo}\n', [`spindle.config.${format}`]: format === 'yaml' ? 'macros:\n  foo:\n  if:\n' : '{"macros":{"foo":null,"if":null}}' });
      try {
        const check = () => spawnSync(process.execPath, [executable(), 'check', 'story.tw', '--format', 'json'], { cwd: fixture.directory, encoding: 'utf8', timeout: 8000 });
        const valid = check();
        expect(valid.status).toBe(0);
        expect(JSON.parse(valid.stdout).files.flatMap((f: any) => f.diagnostics).filter((d: any) => d.severity === 'error')).toEqual([]);
        writeFileSync(join(fixture.directory, `spindle.config.${format}`), format === 'yaml' ? 'macros:\n  foo: 42\n' : '{"macros":{"foo":42}}');
        const invalid = check();
        expect(invalid.status).toBe(1);
        expect(invalid.stderr).toContain('macros.foo');
        expect(invalid.stderr).not.toContain('TypeError');
      } finally { fixture.dispose(); }
    });
  }

  cell('I/entry-cli/CONFIG-ENTRY/mcp-rejected-config', dims('CONFIG-ENTRY', 'controlled MCP error and recovery'), async () => {
    const fixture = project({ 'story.tw': ':: StoryVariables\n:: Start\n{foo}\n', 'spindle.config.yaml': 'macros:\n  foo: 42\n' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [executable(), 'mcp'], cwd: fixture.directory, stderr: 'pipe' });
    const client = new Client({ name: 'repair-config', version: '1' });
    try {
      await client.connect(transport);
      const call = () => client.callTool({ name: 'spindle_check', arguments: { path: 'story.tw' } }, undefined, { timeout: 8000 });
      const rejected = await call();
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected.content)).toContain('macros.foo');
      expect(JSON.stringify(rejected.content)).not.toContain('TypeError');
      writeFileSync(join(fixture.directory, 'spindle.config.yaml'), 'macros:\n  foo:\n');
      const recovered = await call();
      expect(recovered.isError).not.toBe(true);
      expect(JSON.parse((recovered.content as any)[0].text)).toEqual([]);
    } finally { await client.close(); fixture.dispose(); }
  });

  cell('I/entry-lsp/CONFIG-ENTRY/rejected-initial-config', dims('CONFIG-ENTRY', 'initialize with invalid config preserves editor features'), async () => {
    const fixture = project({ 'story.tw': ':: StoryVariables\n:: Start\n{if true}x{/if}\n', 'spindle.config.yaml': 'macros:\n  foo: 42\n' });
    const proc = spawn(process.execPath, [executable(), '--stdio'], { cwd: fixture.directory, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk; });
    const conn = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
    conn.onNotification('window/logMessage', params => { stderr += params.message; });
    conn.onRequest(() => null);
    conn.listen();
    const uri = pathToFileURL(join(fixture.directory, 'story.tw')).toString();
    try {
      const initialized = await conn.sendRequest<any>('initialize', { processId: null, rootUri: pathToFileURL(fixture.directory).toString(), capabilities: {} });
      expect(initialized.capabilities.completionProvider).toBeDefined();
      await conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'twee', version: 1, text: ':: Start\n{' } });
      const items = await conn.sendRequest<any[]>('textDocument/completion', { textDocument: { uri }, position: { line: 1, character: 1 } });
      expect(items.some(item => item.label === 'if')).toBe(true);
      const deadline = Date.now() + 8000;
      while (!stderr.includes('macros.foo') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      expect(stderr).toContain('macros.foo');
      expect(stderr).not.toContain('TypeError');
    } finally { conn.dispose(); proc.kill(); fixture.dispose(); }
  });

  // #93/#94/#97/#98/#99/#101 share one real language-server lifecycle.
  cell('I/entry-lsp/review-repairs', dims('repair contracts', 'initialize/rename/actions/completion/outline/signature/watched reload'), async () => {
    const button = `{button ${JSON.stringify('{goto "Trget"}')}}x{/button}`;
    const text = `:: StoryVariables\n$a = 1\n$b = 2\n$p = {"first-name":"Ada"}\n:: W [widget]\n<!-- {widget "fake"}x{/widget} -->\n{widget\n "one"}one{/widget}\n{widget "two"}two{/widget}\n:: Target\nx\n:: Start\n${button}\n{$p.}\n{custom (1 + 2) 3}\n{foo}\n`;
    const fixture = project({ 'story.tw': text, 'spindle.config.yaml': 'macros:\n  foo:\n  if:\n  custom:\n    parameters: ["number &+ number"]\n', 'macros.js': 'Story.defineMacro({name:"custom",parameters:[{name:"first",type:"expression"},{name:"second",type:"expression"}],render(){return null;}});' });
    const proc = spawn(process.execPath, [executable(), '--stdio'], { cwd: fixture.directory, stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stderr.resume();
    const conn = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
    const uri = pathToFileURL(join(fixture.directory, 'story.tw')).toString();
    const source = TextDocument.create(uri, 'twee', 0, text);
    let diagnostics: any[] | undefined;
    conn.onNotification('textDocument/publishDiagnostics', params => { if (params.uri === uri) diagnostics = params.diagnostics; });
    conn.onRequest(() => null);
    conn.listen();
    const waitFor = async (ready: () => boolean) => {
      const deadline = Date.now() + 8000;
      while (!ready() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      expect(ready()).toBe(true);
    };
    const request = (method: string, params: any) => conn.sendRequest<any>(method, params);
    const position = (fragment: string, delta = 0) => source.positionAt(text.indexOf(fragment) + delta);
    try {
      const initialized = await request('initialize', { processId: null, rootUri: pathToFileURL(fixture.directory).toString(), capabilities: {} });
      expect(initialized.capabilities.renameProvider).toBeDefined();
      await conn.sendNotification('initialized', {});
      await conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'twee', version: 1, text } });
      await waitFor(() => diagnostics?.some(d => d.code === 'SP300') ?? false);
      expect(diagnostics!.filter(d => ['SP100', 'SP109'].includes(d.code))).toEqual([]);
      const rename = (fragment: string, newName: string) => request('textDocument/rename', { textDocument: { uri }, position: position(fragment, 1), newName });
      await expect(rename('$a =', 'b')).rejects.toThrow(/already exists/);
      await expect(rename('"one"', 'TWO')).rejects.toThrow(/already exists/);
      expect((await rename('$a =', 'a')).changes).toEqual({});
      const broken = diagnostics!.filter(d => d.code === 'SP300');
      expect(broken, JSON.stringify(diagnostics)).toHaveLength(1);
      const actions = await request('textDocument/codeAction', { textDocument: { uri }, range: broken[0].range, context: { diagnostics: broken } });
      const action = actions.find((a: any) => a.title === "Change to 'Target'");
      expect(action).toBeDefined();
      const output = TextDocument.applyEdits(source, action.edit.changes[uri]);
      const content = output.split(':: Start\n')[1];
      expect(passagePieces(content, builtinMacros).filter(p => p.kind === 'passage').map(p => p.name)).toEqual(['Target']);
      const completion = await request('textDocument/completion', { textDocument: { uri }, position: position('$p.', 3) });
      const field = completion.find((c: any) => c.label === 'first-name');
      expect(TextDocument.applyEdits(source, [field.textEdit])).toContain('{$p["first-name"]}');
      const symbols = await request('textDocument/documentSymbol', { textDocument: { uri } });
      expect(symbols.find((s: any) => s.name === 'W').children.map((s: any) => s.name)).toEqual(['one', 'two']);
      const signature = await request('textDocument/signatureHelp', { textDocument: { uri }, position: position('{custom (1 + 2) ', 16) });
      expect(signature.activeParameter).toBe(1);
      // Reject an invalid watched reload while preserving the last usable config.
      writeFileSync(join(fixture.directory, 'spindle.config.yaml'), 'macros:\n  foo: 42\n');
      await conn.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(join(fixture.directory, 'spindle.config.yaml')).toString(), type: 2 }] });
      const macros = await request('textDocument/completion', { textDocument: { uri }, position: position('{foo}', 1) });
      expect(macros.some((c: any) => c.label === 'foo')).toBe(true);
      diagnostics = undefined;
      writeFileSync(join(fixture.directory, 'spindle.config.yaml'), 'macros:\n  other: {}\n');
      await conn.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(join(fixture.directory, 'spindle.config.yaml')).toString(), type: 2 }] });
      await waitFor(() => diagnostics?.some(d => d.code === 'SP100' && d.message.includes('foo')) ?? false);
    } finally {
      conn.dispose(); proc.kill(); fixture.dispose();
    }
  });
}
