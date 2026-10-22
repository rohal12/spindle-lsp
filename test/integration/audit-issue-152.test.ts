import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveFiles } from '../../src/core/workspace/file-inputs.js';
import { findMacroSourceFiles, findProjectFiles } from '../../src/core/workspace/macro-sources.js';
import { checkFiles, checkFormatting, formatFiles } from '../../src/mcp/server.js';
import { buildDist, type DistBuild } from './support/dist-build.js';

let dist: DistBuild;
let directory: string;
let project: string;
let outside: string;
const story = ':: StoryVariables\n:: Start\nHello.\n';
const sentinel = '::   Outside\n{unknownMacro}   \n';
beforeAll(() => { dist = buildDist(); });
afterAll(() => dist?.dispose());
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spindle-audit-152-'));
  project = join(directory, 'project');
  outside = join(directory, 'outside');
  mkdirSync(project);
  mkdirSync(join(outside, 'nested'), { recursive: true });
  writeFileSync(join(project, 'package.json'), '{}');
  writeFileSync(join(project, 'story.tw'), story);
  writeFileSync(join(outside, 'nested', 'sentinel.tw'), sentinel);
  writeFileSync(join(outside, 'macro.js'), 'Story.defineMacro({name:"external"});');
  symlinkSync(join(outside, 'nested', 'sentinel.tw'), join(project, 'external.tw'));
  symlinkSync(join(project, 'story.tw'), join(project, 'alias.tw'));
  symlinkSync(join(outside, 'macro.js'), join(project, 'macro.js'));
  symlinkSync(outside, join(project, 'linked'), 'dir');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function expectSentinelUnchanged() {
  expect(readFileSync(join(outside, 'nested', 'sentinel.tw'), 'utf8')).toBe(sentinel);
}

it.each(['.', '**/*.{tw,twee}', '*.tw', 'linked', 'linked/nested', 'linked/**/*.tw', 'linked/nested/*.tw'])(
  'automatic discovery and MCP operations avoid symlink traversal via %s (#152)', async pattern => {
    const expected = pattern.startsWith('linked') ? [] : [join(project, 'story.tw')];
    for (const input of [pattern, join(project, pattern)]) {
      expect(await resolveFiles(input, project)).toEqual(expected);
      expect(await checkFiles(input, undefined, project)).toEqual([]);
      expect(await checkFormatting(input, project)).toMatchObject({ needsFormatting: [] });
      expect(await formatFiles(input, project)).toMatchObject({ formatted: 0, files: [] });
      expectSentinelUnchanged();
    }
  },
);

it('shared LSP/story/macro discovery excludes file and directory links (#152)', async () => {
  expect(await findProjectFiles(project, '**/*.{tw,twee}')).toEqual([join(project, 'story.tw')]);
  expect(await findMacroSourceFiles(project)).toEqual([]);
  expect(await findProjectFiles(project, 'linked/nested/*.tw')).toEqual([]);
  expectSentinelUnchanged();
});

it('skips broken links without losing readable project files (#152)', async () => {
  symlinkSync(join(directory, 'missing'), join(project, 'broken.tw'));
  expect(await resolveFiles('.', project)).toEqual([join(project, 'story.tw')]);
  expect(await formatFiles('.', project)).toMatchObject({ formatted: 0, unchanged: 1 });
  expectSentinelUnchanged();
});

it.each([
  { args: [] }, { args: ['.'] }, { args: ['**/*.{tw,twee}'] },
  { args: ['linked/nested'] }, { args: ['linked/nested/*.tw'] },
])(
  'CLI format leaves external files unchanged with arguments $args (#152)', ({ args }) => {
    writeFileSync(join(project, 'story.tw'), story.replace(':: Start', '::   Start'));
    const result = spawnSync(process.execPath, [dist.executable, 'format', ...args], { cwd: project, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expectSentinelUnchanged();
    if (!args[0]?.startsWith('linked')) expect(readFileSync(join(project, 'story.tw'), 'utf8')).toBe(story);
  },
);

it('CLI scans do not enumerate linked directories, including literal glob prefixes (#152)', () => {
  const log = join(directory, 'readdir.log');
  const instrument = join(directory, 'observe-readdir.mjs');
  // Load before the executable so glob and the discovery guard both use the
  // observed real filesystem operation, including any cached function imports.
  writeFileSync(instrument, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const readdir = fs.readdir;
    fs.readdir = (path, ...args) => {
      fs.appendFileSync(${JSON.stringify(log)}, String(path) + '\\n');
      return readdir(path, ...args);
    };
    syncBuiltinESMExports();
  `);
  for (const pattern of ['.', 'linked/**/*.tw']) {
    writeFileSync(log, '');
    const result = spawnSync(process.execPath, ['--import', instrument, dist.executable, 'format', pattern], {
      cwd: project, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const directories = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    if (pattern === '.') expect(directories).toContain(project);
    expect(directories.filter(path => path.startsWith(join(project, 'linked')))).toEqual([]);
    expectSentinelUnchanged();
  }
});

it('the real MCP format tool skips links while formatting project files (#152)', async () => {
  writeFileSync(join(project, 'story.tw'), story.replace(':: Start', '::   Start'));
  const client = new Client({ name: 'symlink-regression', version: '0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [dist.executable, 'mcp'], cwd: project,
    env: { ...process.env } as Record<string, string>, stderr: 'ignore',
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: 'spindle_format', arguments: { path: '.' } });
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual({ formatted: 1, unchanged: 0, files: ['story.tw'] });
    expect(readFileSync(join(project, 'story.tw'), 'utf8')).toBe(story);
    expectSentinelUnchanged();
  } finally { await client.close(); }
});

it('a literal file link remains an explicit opt-in (#152)', async () => {
  const link = join(project, 'external.tw');
  expect(await resolveFiles(link, project)).toEqual([link]);
  expect(await formatFiles(link, project)).toMatchObject({ formatted: 1, files: ['external.tw'] });
  expect(readFileSync(join(outside, 'nested', 'sentinel.tw'), 'utf8')).toBe(':: Outside\n{unknownMacro}\n');
});
