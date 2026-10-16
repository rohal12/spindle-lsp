/** Public operations for the October 16 extensions of the retained contracts. */
import { expect } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Dims } from './harness.js';

type Cell = (id: string, dims: Dims, run: () => void | Promise<void>) => void;
const unformatted = '::StoryVariables\n::Start\n{if true}\nhi\n{/if}\n';
function project(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'spindle-audit-'));
  chmodSync(directory, 0o755);
  for (const [name, text] of Object.entries({ 'package.json': '{}', ...files })) {
    const file = join(directory, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  }
  return { directory, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}
const dims = (contract: string, consumer: string): Dims => ({ role: 'ordinary/declarations/widgets', context: contract, spelling: 'ticket reproduction/control', boundary: 'LF/CRLF', state: 'disk/public stdio', consumer });
// Permission assertions must still exercise EACCES when CI itself runs as root.
const identity = () => process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
const cli = (executable: string, directory: string, args: string[]) => spawnSync(process.execPath, [executable, ...args], { cwd: directory, encoding: 'utf8', timeout: 4000, ...identity() });
async function mcp(executable: string, directory: string, tool: string, path: string) {
  const bootstrap = `if(process.getuid?.()===0){process.setgid(65534);process.setuid(65534);}process.argv=[process.execPath,${JSON.stringify(executable)},'mcp'];await import(${JSON.stringify(pathToFileURL(executable).toString())});`;
  const client = new Client({ name: 'audit-contracts', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '-e', bootstrap], cwd: directory, stderr: 'pipe' });
  try {
    await client.connect(transport);
    return await client.callTool({ name: tool, arguments: { path } });
  } finally { await client.close(); }
}

export function registerAuditEntrypoints(cell: Cell, executable: () => string): void {
  for (const command of ['check', 'format-check', 'format']) {
    for (const spelling of ['brackets', 'directory-brackets', 'ordinary', 'glob', 'overlap']) {
      for (const absolute of [true, false]) {
        cell(`I/entry-cli/CLI-PATH/${command}/${spelling}/${absolute ? 'absolute' : 'relative'}`, dims('CLI-PATH', 'literal path precedence, real glob and deduplicated inputs'), () => {
          const name = spelling === 'directory-brackets' ? 'Part [draft]/Chapter [draft].tw' : spelling === 'ordinary' ? 'story.tw' : 'Chapter [draft].tw';
          const other = spelling === 'directory-brackets' ? 'Part [draft]/Chapter d.tw' : 'Chapter d.tw';
          const broken = '::StoryVariables\n::Start\n{if true}\n';
          const fixture = project({ [name]: command === 'check' ? broken : unformatted, [other]: unformatted });
          const file = join(fixture.directory, name);
          const asArgument = (value: string) => absolute ? join(fixture.directory, value) : value;
          const pattern = spelling === 'glob' ? '**/*.tw' : name;
          const inputs = spelling === 'overlap' ? [asArgument(name), asArgument('**/*.tw'), asArgument(name)] : [asArgument(pattern)];
          const args = command === 'check' ? ['check', '--format', 'json', ...inputs] : ['format', ...(command === 'format-check' ? ['--check'] : []), ...inputs];
          try {
            const result = cli(executable(), fixture.directory, args);
            expect(result.status, result.stderr).toBe(command === 'format' ? 0 : 1);
            if (command === 'check') {
              const files = JSON.parse(result.stdout).files;
              expect(files.flatMap((f: any) => f.diagnostics).filter((d: any) => d.code === 'SP101')).toHaveLength(1);
            } else if (command === 'format-check') {
              expect(result.stdout).toContain(name);
              expect(result.stdout).toContain(spelling === 'glob' || spelling === 'overlap' ? '2 files would be reformatted' : '1 file would be reformatted');
            } else {
              expect(readFileSync(file, 'utf8')).toContain('  hi');
            }
            if (spelling !== 'glob' && spelling !== 'overlap') expect(readFileSync(join(fixture.directory, other), 'utf8')).toBe(unformatted);
            if (command !== 'format') expect(readFileSync(file, 'utf8')).toBe(command === 'check' ? broken : unformatted);
          } finally { fixture.dispose(); }
        });
      }
    }
  }

  for (const consumer of ['cli', 'mcp']) for (const operation of ['check', 'format', 'format-check']) {
    for (const failure of ['read-denied', 'write-denied', 'success', 'no-files']) {
      if (failure === 'write-denied' && operation !== 'format') continue;
      cell(`I/entry-cli/FILE-IO/${consumer}/${operation}/${failure}`, dims('FILE-IO', 'public nonzero/tool-error results on real filesystem failures'), async () => {
        const fixture = project({ 'a-readable.tw': unformatted, 'b-denied.tw': unformatted });
        const denied = join(fixture.directory, 'b-denied.tw');
        const mode = failure === 'read-denied' ? 0 : failure === 'write-denied' ? 0o444 : 0o644;
        chmodSync(denied, mode);
        const path = failure === 'no-files' ? 'missing-*.tw' : '*.tw';
        try {
          const failed = failure.endsWith('denied');
          if (consumer === 'cli') {
            const args = operation === 'check' ? ['check', '--format', 'json', path] : ['format', ...(operation === 'format-check' ? ['--check'] : []), path];
            const result = cli(executable(), fixture.directory, args);
            expect(result.status, result.stderr).toBe(failed ? 2 : operation === 'format-check' && failure !== 'no-files' ? 1 : 0);
            if (failed) expect(result.stderr).toMatch(/b-denied\.tw/);
          } else {
            const tool = { check: 'spindle_check', format: 'spindle_format', 'format-check': 'spindle_format_check' }[operation]!;
            const result = await mcp(executable(), fixture.directory, tool, path);
            expect(result.isError === true).toBe(failed);
            const content = (result.content as any[]).map(c => c.text).join('\n');
            if (failed) expect(content).toMatch(/b-denied\.tw/);
            else if (operation === 'format' && failure === 'success') expect(JSON.parse(content).formatted).toBe(2);
          }
          if (failed || operation !== 'format' || failure === 'no-files') {
            chmodSync(denied, 0o644);
            expect(readFileSync(denied, 'utf8')).toBe(unformatted);
          }
          // Reads are preflighted before either diagnostics or file writes.
          if (failure === 'read-denied') expect(readFileSync(join(fixture.directory, 'a-readable.tw'), 'utf8')).toBe(unformatted);
        } finally { chmodSync(denied, 0o644); fixture.dispose(); }
      });
    }
  }

  for (const role of ['StoryVariables', 'StoryTransients', 'StoryData', 'SaveTitle']) for (const eol of ['\n', '\r\n']) {
    cell(`I/entry-cli/FORMAT-ROLE/${role}/${eol.length}`, dims('FORMAT-ROLE', 'CLI width option preserves runtime payload'), () => {
      const literal = 'this is a fairly long string that contains words and spaces';
      const body = role === 'StoryVariables' ? `$msg = ${JSON.stringify(literal)}` : role === 'StoryTransients' ? `%msg = ${JSON.stringify(literal)}` : role === 'StoryData' ? JSON.stringify({ label: literal }) : `return ${JSON.stringify(literal)};`;
      const fixture = project({ 'story.tw': `${role === 'StoryVariables' ? '' : '::StoryVariables\n'}::${role}\n${body}\n::Start\nhello\n`.replaceAll('\n', eol) });
      try {
        const args = ['format', '--max-line-length', '25', 'story.tw'];
        expect(cli(executable(), fixture.directory, args).status).toBe(0);
        const output = readFileSync(join(fixture.directory, 'story.tw'), 'utf8');
        expect(output).toContain(body + eol);
        const checked = cli(executable(), fixture.directory, ['check', '--format', 'json', 'story.tw']);
        expect(checked.status, checked.stderr).toBe(0);
        expect(cli(executable(), fixture.directory, args).status).toBe(0);
        expect(readFileSync(join(fixture.directory, 'story.tw'), 'utf8')).toBe(output);
      } finally { fixture.dispose(); }
    });
  }

  for (const shape of ['tags', 'metadata', 'mixed', 'ordinary', 'escaped']) {
    for (const size of [40000, 160000]) {
      cell(`I/entry-cli/HEADER/adversarial-${shape}/${size}`, dims('HEADER', 'bounded subprocess parsing and ordinary/escaped controls'), () => {
        const name = shape === 'tags' ? 'Name ' + '['.repeat(size) : shape === 'metadata' ? 'Name ' + '{'.repeat(size) : shape === 'mixed' ? 'Name ' + '[{'.repeat(size / 2) : shape === 'escaped' ? '\\['.repeat(size / 2) : 'a'.repeat(size);
        const fixture = project({ 'story.tw': `::${name}\n::StoryVariables\n::Start\nhello\n` });
        try {
          const checked = cli(executable(), fixture.directory, ['check', '--format', 'json', 'story.tw']);
          expect(checked.error, checked.stderr).toBeUndefined();
          expect(checked.status, checked.stderr).toBe(0);
        } finally { fixture.dispose(); }
      });
    }
  }

  cell('I/entry-lsp/HEADER-WIDGET-HOLDS', dims('HEADER/WIDGET-HOLDS', 'framed LSP responsiveness, references/definition/rename and applied declaration fix'), async () => {
    const defs = '::W [widget]\n{widget "Show" @arg:passage}{include @arg}{/widget}\n';
    const text = '::StoryVariables\n$known = 0\n::Start\n{print $missing}\n{Show "Hall"}\n{include "Hall"}\n::Hall\nhi\n';
    const fixture = project({ 'story.tw': text, 'definitions.tw': defs });
    const proc = spawn(process.execPath, [executable(), '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stderr.resume();
    const conn = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
    const uri = pathToFileURL(join(fixture.directory, 'story.tw')).toString();
    const source = TextDocument.create(uri, 'twee', 0, text);
    const textDocument = { uri };
    let diagnostics: any[] | undefined;
    conn.onNotification('textDocument/publishDiagnostics', params => { if (params.uri === uri) diagnostics = params.diagnostics; });
    conn.onRequest(() => null);
    conn.listen();
    const request = async (method: string, params: any) => {
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await Promise.race([conn.sendRequest<any>(method, params), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} timed out`)), 4000); })]);
      } finally { clearTimeout(timer!); }
    };
    const position = (fragment: string, delta = 0) => source.positionAt(text.indexOf(fragment) + delta);
    try {
      await request('initialize', { processId: null, rootUri: pathToFileURL(fixture.directory).toString(), capabilities: {} });
      await conn.sendNotification('initialized', {});
      await conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'twee', version: 1, text } });
      const deadline = Date.now() + 4000;
      while (!diagnostics?.some(d => d.code === 'SP200') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      const diagnostic = diagnostics!.find(d => d.code === 'SP200');
      expect(diagnostic).toBeDefined();
      const refs = await request('textDocument/references', { textDocument, position: position('"Hall"', 2), context: { includeDeclaration: false } });
      expect(refs).toHaveLength(2);
      expect((await request('textDocument/definition', { textDocument, position: position('"Hall"', 2) })).uri).toBe(uri);
      const edits = await request('textDocument/rename', { textDocument, position: position('"Hall"', 2), newName: 'Lobby' });
      const renamed = TextDocument.applyEdits(source, edits.changes[uri]);
      expect(renamed).toContain('{Show "Lobby"}');
      expect(renamed).toContain('{include "Lobby"}');
      const actions = await request('textDocument/codeAction', { textDocument, range: diagnostic.range, context: { diagnostics: [diagnostic] } });
      const action = actions.find((a: any) => a.title.startsWith('Declare'));
      const fixed = TextDocument.applyEdits(source, action.edit.changes[uri]);
      expect(fixed).toContain('$missing = 0\n::Start\n{print $missing}');
      diagnostics = undefined;
      await conn.sendNotification('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: fixed }] });
      await request('textDocument/documentSymbol', { textDocument });
      const clearedDeadline = Date.now() + 4000;
      while (!diagnostics && Date.now() < clearedDeadline) await new Promise(resolve => setTimeout(resolve, 20));
      expect(diagnostics!.filter(d => d.code === 'SP200')).toEqual([]);
      // A malformed header must not block the request immediately following didOpen.
      const adversarial = ':: Name ' + '['.repeat(160000) + '\n' + text;
      const badUri = pathToFileURL(join(fixture.directory, 'adversarial.tw')).toString();
      await conn.sendNotification('textDocument/didOpen', { textDocument: { uri: badUri, languageId: 'twee', version: 1, text: adversarial } });
      expect(await request('textDocument/documentSymbol', { textDocument: { uri: badUri } })).toHaveLength(3);
    } finally { conn.dispose(); proc.kill(); fixture.dispose(); }
  });
}
