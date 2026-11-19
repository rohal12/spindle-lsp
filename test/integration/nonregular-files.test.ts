import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-languageserver/node';

const repo = join(import.meta.dirname, '../..');
let bundleDir: string;
let directory: string;

// FIFO reads can block the event loop itself: keep them outside the test
// process and have the OS kill the child if it stops answering.
function run(mode: string, name = '.') {
  const result = spawnSync(process.execPath, [join(bundleDir, 'runner.js'), mode, directory, name], {
    encoding: 'utf8', timeout: 4_000, killSignal: 'SIGKILL',
  });
  expect(result.error, `Child failed: ${result.stderr}`).toBeUndefined();
  return result;
}

function fifo(name: string): void {
  execFileSync('mkfifo', [join(directory, name)]);
}

describe.skipIf(process.platform === 'win32')('regular project sources (#297)', () => {
  beforeAll(async () => {
    const cache = join(repo, 'node_modules/.cache');
    mkdirSync(cache, { recursive: true });
    bundleDir = mkdtempSync(join(cache, 'spindle-nonregular-'));
    for (const [name, entry] of [['runner', 'test/helpers/nonregular-runner.ts'], ['server', 'src/bin.ts']]) {
      await build({
        entryPoints: [join(repo, entry)], outfile: join(bundleDir, `${name}.js`),
        bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['prettier'],
        define: { SPINDLE_LSP_VERSION: JSON.stringify('test') }, logLevel: 'silent',
        banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
      });
    }
  });
  afterAll(() => { if (bundleDir) rmSync(bundleDir, { recursive: true, force: true }); });
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  function project(declared = false): void {
    directory = mkdtempSync(join(tmpdir(), 'spindle-nonregular-'));
    writeFileSync(join(directory, 'package.json'), '{}');
    writeFileSync(join(directory, 'story.tw'), `${declared ? ':: StoryData\n{"format":"Spindle"}\n' : ''}:: Start\nHello\n`);
  }

  it('discovers regular story and macro files while traversing directories', () => {
    project();
    mkdirSync(join(directory, 'nested'));
    writeFileSync(join(directory, 'nested/next.twee'), ':: Next\n');
    writeFileSync(join(directory, 'macros.ts'), '');
    for (const name of ['pipe.tw', 'pipe.twee', 'pipe.js', 'pipe.ts']) fifo(name);
    const result = run('discover');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ stories: ['next.twee', 'story.tw'], macros: ['macros.ts'] });
  });

  it.each(['cli', 'mcp'])('%s automatic story ingestion finishes with FIFO candidates', mode => {
    project(true);
    fifo('pipe.tw');
    fifo('pipe.twee');
    const result = run(mode);
    expect(result.status).toBe(mode === 'cli' ? 1 : 0);
    expect(result.stdout).toContain('SP202');
  });

  it.each(['cli', 'mcp'])('%s automatic macro ingestion finishes with FIFO candidates', mode => {
    project(true);
    fifo('pipe.js');
    fifo('pipe.ts');
    const result = run(mode, 'story.tw');
    expect(result.status).toBe(mode === 'cli' ? 1 : 0);
    expect(result.stdout).toContain('SP202');
  });

  it.each(['pipe.tw', 'pipe.js'])('rejects explicit unsupported source %s with its path', name => {
    project();
    fifo(name);
    const result = run('cli', name);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(name);
    expect(result.stderr).toMatch(/regular file/i);
  });

  it('rejects a story replaced with a FIFO after discovery without blocking', () => {
    project();
    const result = run('replace', 'story.tw');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/regular file/i);
    expect(result.stdout).toContain('story.tw');
  });

  it.each(['scan', 'watch', 'close'])('LSP %s ignores unsupported story and macro files', async mode => {
    project();
    const names = ['other.twee', 'macros.ts'];
    if (mode === 'scan') names.forEach(fifo);
    else {
      writeFileSync(join(directory, names[0]), ':: Other\n');
      writeFileSync(join(directory, names[1]), 'Story.defineMacro({name:"localmacro",run(){}});');
    }
    const proc = spawn(process.execPath, [join(bundleDir, 'server.js'), '--stdio']);
    proc.stderr.resume();
    const conn = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
    conn.onRequest(() => null);
    conn.listen();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`LSP ${mode} blocked on a FIFO`)); }, 5_000);
    });
    try {
      await Promise.race([deadline, (async () => {
        await conn.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(directory).href, capabilities: {} });
        await conn.sendNotification('initialized', {});
        const symbols = () => conn.sendRequest('workspace/symbol', { query: '' }) as Promise<Array<{ name: string }>>;
        expect((await symbols()).map(s => s.name)).toContain('Start');
        if (mode !== 'scan') {
          expect((await symbols()).map(s => s.name)).toContain('Other');
          for (const name of names) {
            const uri = pathToFileURL(join(directory, name)).href;
            if (mode === 'close') await conn.sendNotification('textDocument/didOpen', {
              textDocument: { uri, languageId: 'twee', version: 1, text: name.endsWith('.twee') ? ':: Other\n' : '' },
            });
            unlinkSync(join(directory, name));
            fifo(name);
            await conn.sendNotification(mode === 'close' ? 'textDocument/didClose' : 'workspace/didChangeWatchedFiles',
              mode === 'close' ? { textDocument: { uri } } : { changes: [{ uri, type: 2 }] });
          }
        }
        expect((await symbols()).map(s => s.name)).toEqual(['Start']);
      })()]);
    } finally {
      clearTimeout(timer!);
      conn.dispose();
      proc.kill('SIGKILL');
    }
  });
});
