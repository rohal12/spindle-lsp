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

interface McpMessage {
  id?: number;
  result?: Record<string, unknown> & { tools?: { name: string }[] };
}
/** The `mcp` subcommand over stdio: newline-delimited JSON-RPC, initialized. */
async function mcpProcess(executable: string) {
  const child = spawn(process.execPath, [executable, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, (message: McpMessage) => void>();
  let buffer = '';
  child.stdout.on('data', data => {
    buffer += data;
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const message: McpMessage = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (message.id !== undefined) pending.get(message.id)?.(message);
    }
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let nextId = 1;
  const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const request = (method: string, params: object) =>
    new Promise<McpMessage>(resolve => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ id, method, params });
    });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  send({ method: 'notifications/initialized' });
  return { child, request, exited };
}
/** Resolve with how the process exited, or reject when it is still running after `ms`. */
function exitWithin(exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>, ms: number) {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`still running after ${ms} ms`)), ms); });
  return Promise.race([exited, timeout]).finally(() => clearTimeout(timer));
}
const playFixture = join(import.meta.dirname, '..', 'fixtures', 'play', 'story.twee');

describe('B76: public executable transport (#76)', () => {
  let directory: string;
  let executable: string;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'spindle-review-bin-'));
    executable = join(directory, 'bin.mjs');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    await build({
      entryPoints: ['src/bin.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm',
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
  it('B76-mcp-version: the mcp subcommand reports the package version', async () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const child = spawn(process.execPath, [executable, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let timer: ReturnType<typeof setTimeout>;
    try {
      const serverInfo = await new Promise<{ name?: string; version?: string }>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('mcp initialize timeout')), 4000);
        let buffer = '';
        child.stdout.on('data', data => {
          buffer += data;
          for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
            const message = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            if (message.id === 99) resolve(message.result?.serverInfo ?? {});
          }
        });
        const request = { jsonrpc: '2.0', id: 99, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };
        child.stdin.write(`${JSON.stringify(request)}\n`);
      });
      expect(serverInfo).toEqual({ name: 'spindle-lsp', version: pkg.version });
    } finally {
      clearTimeout(timer!);
      child.kill();
    }
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
  it('B76-dist-play-tools: the mcp subcommand lists the six play tools', async () => {
    const { child, request } = await mcpProcess(dist.executable);
    try {
      const { result } = await request('tools/list', {});
      const names = result?.tools?.map(tool => tool.name) ?? [];
      expect(names.filter(name => name.startsWith('spindle_play_')).sort()).toEqual([
        'spindle_play_goto', 'spindle_play_observe', 'spindle_play_start',
        'spindle_play_step', 'spindle_play_stop', 'spindle_play_vars',
      ]);
    } finally {
      child.kill();
    }
  });
  for (const ending of ['SIGTERM', 'SIGINT', 'stdin close'] as const) {
    it(`B76-dist-play-shutdown: the mcp server exits on ${ending} with a play session open`, async () => {
      const { child, request, exited } = await mcpProcess(dist.executable);
      try {
        const { result } = await request('tools/call', { name: 'spindle_play_start', arguments: { story: playFixture } });
        expect(result?.isError, JSON.stringify(result)).toBeFalsy();
        if (ending === 'stdin close') child.stdin.end();
        else child.kill(ending);
        const exit = await exitWithin(exited, 10_000);
        expect(exit.signal ?? exit.code).toBe(ending === 'stdin close' ? 0 : ending);
      } finally {
        child.kill('SIGKILL');
      }
    });
  }
});
