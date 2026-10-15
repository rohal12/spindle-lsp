/**
 * Packaging smoke check: install spindle-lsp the way npm users get it and play
 * a story through the installed `spindle-lsp mcp`.
 *
 *   npm run smoke:pack
 *
 * It builds and packs spindle-lsp, installs the tarball into a fresh project
 * outside the repository, starts `dist/bin.js mcp` over stdio there, calls
 * `spindle_play_start` on test/fixtures/play/story.twee and expects
 * `Passage: Start`. While the @rohal12/spindle dependency is a `file:` link,
 * that Spindle checkout is packed too (with its scripts off; build it first)
 * and swapped in with an npm override, so nothing outside the temporary
 * project is resolved.
 *
 * The project is made under SMOKE_PACK_DIR, else the system temp directory.
 * No parent of it may hold a node_modules, package.json or .git: Node and npm
 * would resolve packages from there and hide a missing dependency.
 * SMOKE_PACK_KEEP=1 keeps the project for inspection.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPINDLE = '@rohal12/spindle';

function run(command: string, args: string[], cwd: string, env = process.env): string {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/**
 * Pack the package in `dir` into the new directory `into`; returns the
 * tarball's path. With `foreign`, its scripts stay off: npm still runs
 * `prepare`, so HUSKY=0 keeps Spindle's from touching that checkout's git hooks.
 */
function pack(dir: string, into: string, foreign = false): string {
  mkdirSync(into);
  const args = ['pack', '--pack-destination', into];
  if (foreign) args.push('--ignore-scripts');
  const env = foreign ? { ...process.env, HUSKY: '0' } : process.env;
  run('npm', args, dir, env);
  const [tarball] = readdirSync(into);
  return join(into, tarball!);
}

/** Refuse a base whose parents would let resolution escape the temporary project. */
function checkIsolated(base: string): void {
  for (let dir = base; ; dir = dirname(dir)) {
    for (const name of ['node_modules', 'package.json', '.git']) {
      if (existsSync(join(dir, name))) {
        throw new Error(
          `${join(dir, name)} would leak into the smoke project; ` +
            'set SMOKE_PACK_DIR to a clean directory',
        );
      }
    }
    if (dirname(dir) === dir) return;
  }
}

async function playInstalled(project: string): Promise<void> {
  const bin = join(project, 'node_modules', '@rohal12', 'spindle-lsp', 'dist', 'bin.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, 'mcp'],
    cwd: project,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'smoke-pack', version: '0' });
  await client.connect(transport);
  try {
    const started = (await client.callTool({
      name: 'spindle_play_start',
      arguments: { story: 'story.twee' },
    })) as {
      isError?: boolean;
      content: { text: string }[];
      structuredContent?: { session?: string };
    };
    const text = started.content[0]?.text ?? '';
    if (started.isError || !text.includes('Passage: Start')) {
      throw new Error(`spindle_play_start did not reach Passage: Start:\n${text}`);
    }
    console.log(text);
    await client.callTool({
      name: 'spindle_play_stop',
      arguments: { session: started.structuredContent?.session },
    });
  } finally {
    await client.close();
  }
}

const base = resolve(process.env.SMOKE_PACK_DIR || tmpdir());
checkIsolated(base);
mkdirSync(base, { recursive: true });
const work = mkdtempSync(join(base, 'spindle-lsp-smoke-'));
try {
  const project = join(work, 'project');
  mkdirSync(project);

  run('npm', ['run', 'build'], repo);
  const lsp = pack(repo, join(work, 'spindle-lsp'));
  const manifest: Record<string, unknown> = {
    name: 'spindle-lsp-smoke',
    private: true,
    dependencies: { '@rohal12/spindle-lsp': `file:${lsp}` },
  };
  const { dependencies } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf-8'));
  const spec: string = dependencies[SPINDLE];
  if (spec.startsWith('file:')) {
    const spindle = pack(resolve(repo, spec.slice('file:'.length)), join(work, 'spindle'), true);
    manifest.overrides = { [SPINDLE]: `file:${spindle}` };
  }
  writeFileSync(join(project, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], project);
  copyFileSync(join(repo, 'test', 'fixtures', 'play', 'story.twee'), join(project, 'story.twee'));

  await playInstalled(project);
  console.log('smoke:pack passed');
} finally {
  if (process.env.SMOKE_PACK_KEEP) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
