import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

  it.each(['spindle.config.yaml', 'spindle.config.yml', 'spindle.config.json', 't3lt.twee-config.yaml'])
  ('rejects automatic FIFO metadata %s without blocking (#299)', name => {
    project();
    fifo(name);
    const result = run('config');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(name);
    expect(result.stderr).toMatch(/regular file/i);
    const cli = run('cli', 'story.tw');
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain(name);
  });

  it.each(['config-file', 'cli-config'])('rejects explicit FIFO config through %s (#299)', mode => {
    project();
    fifo('custom.yaml');
    const result = run(mode, 'custom.yaml');
    expect(result.status).toBe(mode === 'cli-config' ? 2 : 1);
    expect(result.stderr).toContain('custom.yaml');
    expect(result.stderr).toMatch(/regular file/i);
  });

  it.each(['fifo', 'directory'])('ignores %s package metadata in all version readers (#299)', kind => {
    project();
    unlinkSync(join(directory, 'package.json'));
    if (kind === 'fifo') fifo('package.json');
    else mkdirSync(join(directory, 'package.json'));
    const result = run('version');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ target: { source: 'default', supported: true }, installed: null, package: null });
    expect(run('cli', 'story.tw').status).toBe(0);
  });

  it.each(['direct', 'symlink'])('reads %s regular config and package metadata (#299)', kind => {
    project();
    const pkg = JSON.stringify({ name: '@rohal12/spindle', version: '0.64.24', dependencies: { '@rohal12/spindle': '*' } });
    const config = JSON.stringify({ macros: { custom: { block: true } } });
    const installed = join(directory, 'node_modules/@rohal12/spindle');
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'package.json'), pkg);
    if (kind === 'direct') {
      writeFileSync(join(directory, 'package.json'), pkg);
      writeFileSync(join(directory, 'spindle.config.json'), config);
    } else {
      unlinkSync(join(directory, 'package.json'));
      writeFileSync(join(directory, 'manifest.json'), pkg);
      writeFileSync(join(directory, 'config.json'), config);
      symlinkSync('manifest.json', join(directory, 'package.json'));
      symlinkSync('config.json', join(directory, 'spindle.config.json'));
    }
    expect(JSON.parse(run('config').stdout)).toEqual(JSON.parse(config));
    expect(JSON.parse(run('config-file', 'spindle.config.json').stdout)).toEqual(JSON.parse(config));
    expect(JSON.parse(run('version').stdout)).toEqual({
      target: { version: '0.64.24', source: 'installed', supported: true }, installed: '0.64.24', package: '0.64.24',
    });
  });

  it.each(['installed', 'member'])('ignores FIFO %s package manifests (#299)', kind => {
    project();
    if (kind === 'installed') {
      writeFileSync(join(directory, 'package.json'), '{"dependencies":{"@rohal12/spindle":"*"}}');
      mkdirSync(join(directory, 'node_modules/@rohal12/spindle'), { recursive: true });
      fifo('node_modules/@rohal12/spindle/package.json');
    } else {
      writeFileSync(join(directory, 'package.json'), '{"workspaces":["packages/*"]}');
      mkdirSync(join(directory, 'packages/story'), { recursive: true });
      fifo('packages/story/package.json');
    }
    expect(run('version').status).toBe(0);
  });

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
