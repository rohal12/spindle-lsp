import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkFiles, checkFormatting, formatFiles } from '../../src/mcp/server.js';
import { resolveFiles, resolveInputs } from '../../src/core/workspace/file-inputs.js';
import { buildDist, type DistBuild } from './support/dist-build.js';

let dist: DistBuild;
let directory: string;
const story = ':: StoryVariables\n$x = 1\n:: Start\n{$x}\n';
const excluded = ['node_modules/story-library/fixture.tw', 'dist/copy.tw', 'build/copy.twee', 'chapters/node_modules/library/fixture.tw', '.hidden/fixture.tw'];
const dependency = ':: StoryVariables\n::   Library [script]\nconst x=1\n:: Generated\n{unknownMacro}\n';
beforeAll(() => { dist = buildDist(); });
afterAll(() => dist?.dispose());
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spindle-audit-149-'));
  writeFileSync(join(directory, 'package.json'), '{}');
  writeFileSync(join(directory, 'story.tw'), story);
  for (const path of excluded) {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), dependency);
  }
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function cli(...args: string[]) {
  const result = spawnSync(process.execPath, [dist.executable, ...args], { cwd: directory, encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  return result;
}
function expectExcludedUnchanged() {
  for (const path of excluded) expect(readFileSync(join(directory, path), 'utf8'), path).toBe(dependency);
}

it.each(['**/*.{tw,twee}', '.', 'chapters'])('shares project exclusions for discovery via %s (#149)', async pattern => {
  expect(await resolveFiles(pattern, directory)).toEqual(pattern === 'chapters' ? [] : [join(directory, 'story.tw')]);
  expect(await resolveInputs([pattern, 'story.tw'], directory)).toEqual([join(directory, 'story.tw')]);
});

for (const path of excluded) {
  it(`allows explicitly selected ${path} despite discovery exclusions (#149)`, async () => {
    expect(await resolveFiles(path, directory)).toEqual([join(directory, path)]);
    expect((await checkFiles(path, undefined, directory)).some(d => d.code === 'SP100')).toBe(true);
    expect((await formatFiles(path, directory)).files).toEqual([path]);
    expect(readFileSync(join(directory, path), 'utf8')).toContain('const x = 1;');
  });
}

for (const input of [[], ['.']]) {
  it(`CLI ${input.length ? 'directory' : 'default'} check and format ignore vendored/generated stories (#149)`, () => {
    const checked = cli('check', '--format=json', ...input);
    expect(checked.status, checked.stderr || checked.stdout).toBe(0);
    expect(JSON.parse(checked.stdout).files).toEqual([]);
    expect(cli('format', '--check', ...input).status).toBe(0);
    writeFileSync(join(directory, 'story.tw'), story.replace(':: Start', '::   Start'));
    expect(cli('format', '--check', ...input).status).toBe(1);
    expect(cli('format', ...input).status).toBe(0);
    expect(readFileSync(join(directory, 'story.tw'), 'utf8')).toBe(story);
    expectExcludedUnchanged();
    // A literal file remains an explicit opt-in for both CLI commands.
    const explicit = cli('check', '--format=json', excluded[0]);
    expect(JSON.parse(explicit.stdout).files[0].diagnostics.some((d: { code: string }) => d.code === 'SP100')).toBe(true);
    expect(cli('format', excluded[0]).status).toBe(0);
    expect(readFileSync(join(directory, excluded[0]), 'utf8')).toContain('const x = 1;');
  });
}

it.each(['**/*.{tw,twee}', '.'])('MCP discovery via %s ignores dependency declarations and preserves excluded bytes (#149)', async pattern => {
  expect(await checkFiles(pattern, undefined, directory)).toEqual([]);
  expect(await checkFormatting(pattern, directory)).toMatchObject({ needsFormatting: [], alreadyFormatted: ['story.tw'] });
  writeFileSync(join(directory, 'story.tw'), story.replace(':: Start', '::   Start'));
  expect(await formatFiles(pattern, directory)).toMatchObject({ formatted: 1, files: ['story.tw'] });
  expect(readFileSync(join(directory, 'story.tw'), 'utf8')).toBe(story);
  expectExcludedUnchanged();
});
