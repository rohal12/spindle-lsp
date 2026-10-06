import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { build } from 'esbuild';
import { buildDist, type DistBuild } from './support/dist-build.js';

interface InitializeResponse {
  id?: unknown;
  result?: { capabilities?: unknown };
}
async function initialize(executable: string, args: string[]): Promise<{ output: string; response?: InitializeResponse }> {
  const child = spawn(process.execPath, [executable, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let buffer = Buffer.alloc(0);
  let stderr = '';
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`initialize timeout: ${stderr}`)), 4000);
      child.on('error', reject);
      child.stdin.on('error', () => {}); // an early exit is reported by the missing response
      child.stderr.on('data', data => { stderr += data; });
      child.stdout.on('data', data => {
        output += data;
        buffer = Buffer.concat([buffer, data]);
        for (;;) {
          const split = buffer.indexOf('\r\n\r\n');
          if (split < 0) break;
          const length = /Content-Length: (\d+)/i.exec(buffer.subarray(0, split).toString())?.[1];
          if (!length || buffer.length < split + 4 + Number(length)) break;
          const end = split + 4 + Number(length);
          const message: InitializeResponse = JSON.parse(buffer.subarray(split + 4, end).toString());
          buffer = buffer.subarray(end);
          if (message.id === 99) resolve({ output, response: message });
        }
      });
      child.on('exit', () => resolve({ output }));
      const request = JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`);
    });
  } finally {
    clearTimeout(timer!);
    child.kill();
  }
}

describe('B76: public executable transport (#76)', () => {
  let directory: string;
  let executable: string;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'spindle-review-bin-'));
    executable = join(directory, 'bin.mjs');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    await build({
      entryPoints: ['src/bin.ts'], bundle: true, platform: 'node', target: 'node18', format: 'esm',
      outfile: executable, external: ['prettier'],
      define: { SPINDLE_LSP_VERSION: JSON.stringify(pkg.version) },
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    });
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it('B76-default: no arguments receives a JSON-RPC initialize response', async () => {
    const { output, response } = await initialize(executable, []);
    expect(output).toMatch(/^Content-Length:/);
    expect(response?.id).toBe(99);
    expect(response?.result?.capabilities).toBeDefined();
  });
  it('C-B76: explicit --stdio receives a JSON-RPC initialize response', async () => {
    const { output, response } = await initialize(executable, ['--stdio']);
    expect(output).toMatch(/^Content-Length:/);
    expect(response?.id).toBe(99);
    expect(response?.result?.capabilities).toBeDefined();
  });

  it('B76-help: --help still prints usage and exits', () => {
    const out = execFileSync(process.execPath, [executable, '--help'], { encoding: 'utf8' });
    expect(out).toContain('Usage:');
  });
  it('B76-version: --version still prints the package version', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(execFileSync(process.execPath, [executable, '--version'], { encoding: 'utf8' }).trim()).toBe(pkg.version);
  });
  it('B76-check: check subcommand still dispatches', () => {
    const file = join(directory, 'story.tw');
    writeFileSync(file, ':: StoryVariables\n:: Start\nhello\n');
    const out = execFileSync(process.execPath, [executable, 'check', '--format', 'json', file], { encoding: 'utf8' });
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

describe('B76-dist: the executable built by `npm run build`', () => {
  let dist: DistBuild;
  beforeAll(() => { dist = buildDist(); }, 60_000);
  afterAll(() => dist?.dispose());

  it('B76-dist-default: no arguments receives a JSON-RPC initialize response', async () => {
    const { output, response } = await initialize(dist.executable, []);
    expect(output).toMatch(/^Content-Length:/);
    expect(response?.id).toBe(99);
    expect(response?.result?.capabilities).toBeDefined();
  });
  it('B76-dist-stdio: explicit --stdio receives a JSON-RPC initialize response', async () => {
    const { output, response } = await initialize(dist.executable, ['--stdio']);
    expect(output).toMatch(/^Content-Length:/);
    expect(response?.id).toBe(99);
    expect(response?.result?.capabilities).toBeDefined();
  });
  it('B76-dist-help: --help prints usage and exits', () => {
    const out = execFileSync(process.execPath, [dist.executable, '--help'], { encoding: 'utf8' });
    expect(out).toContain('Usage:');
  });
  it('B76-dist-version: --version prints the package version', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(execFileSync(process.execPath, [dist.executable, '--version'], { encoding: 'utf8' }).trim()).toBe(pkg.version);
  });
});
