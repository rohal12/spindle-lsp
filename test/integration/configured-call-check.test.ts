import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { checkProject } from '../../src/mcp/server.js';
import { buildDist, type DistBuild } from './support/dist-build.js';

let build: DistBuild;
const directories: string[] = [];
beforeAll(() => { build = buildDist(); });
afterAll(() => {
  build?.dispose();
  directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

function project(macros: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-configured-calls-'));
  directories.push(dir);
  writeFileSync(join(dir, 'spindle.config.json'), JSON.stringify({ macros }));
  return dir;
}

for (const count of [1998, 2000]) for (const invalidFirst of [false, true]) {
  it(`retains independent call errors with ${count} repeated arguments (invalid first: ${invalidFirst}, #269)`, async () => {
    const dir = project({ many: { parameters: ['...number'] }, one: { parameters: ['number'] } });
    const large = `{many ${Array(count).fill('1').join(' ')}}`;
    const invalid = '{one "wrong"}';
    const file = join(dir, 'story.tw');
    writeFileSync(file, ':: StoryVariables\n:: Start\n' + (invalidFirst ? invalid + '\n' + large : large + '\n' + invalid));
    const cli = spawnSync(process.execPath, [build.executable, 'check', file, '--format', 'json'], { cwd: dir, encoding: 'utf8' });
    expect(cli.stderr).toBe('');
    expect(cli.status).toBe(1);
    const cliErrors = JSON.parse(cli.stdout).files.flatMap((entry: { diagnostics: unknown[] }) => entry.diagnostics);
    const mcpErrors = (await checkProject('story.tw', undefined, dir)).results;
    for (const errors of [cliErrors, mcpErrors]) {
      expect(errors).toContainEqual(expect.objectContaining({ code: 'SP109', message: '{one}: Argument is not a number', severity: 'error' }));
      expect(errors.filter((d: { code: string }) => d.code === 'SP109')).toHaveLength(count === 2000 ? 2 : 1);
      if (count === 2000) expect(errors).toContainEqual(expect.objectContaining({ code: 'SP109', message: expect.stringContaining('{many}: Unable to validate arguments:') }));
    }
  });
}

it('reports an oversized call by itself instead of silently succeeding (#269)', async () => {
  const dir = project({ many: { parameters: ['...number'] } });
  const file = join(dir, 'story.tw');
  writeFileSync(file, `:: StoryVariables\n:: Start\n{many ${Array(2000).fill('1').join(' ')}}`);
  const cli = spawnSync(process.execPath, [build.executable, 'check', file, '--format', 'json'], { cwd: dir, encoding: 'utf8' });
  expect(cli.status).toBe(1);
  expect((await checkProject('story.tw', undefined, dir)).results).toContainEqual(expect.objectContaining({ code: 'SP109', severity: 'error' }));
});

it('accepts parent-owned clauses with configured same-named macros in CLI and MCP (#270)', async () => {
  const dir = project({ option: { parameters: ['number'] }, else: { parameters: ['number'] } });
  const file = join(dir, 'story.tw');
  const text = ':: StoryVariables\n$choice = "yes"\n:: Macros [script]\n'
    + 'Story.defineMacro({name:"option",render(){return "replacement";}});\n'
    + 'Story.defineMacro({name:"else",render(){return "replacement";}});\n:: Start\n'
    + '{listbox $choice}{option "yes"}{/listbox}\n{if false}no{else}yes{/if}';
  writeFileSync(file, text);
  const cli = spawnSync(process.execPath, [build.executable, 'check', file, '--format', 'json'], { cwd: dir, encoding: 'utf8' });
  expect(cli.status).toBe(0);
  expect(JSON.parse(cli.stdout)).toEqual({ files: [] });
  expect(await checkProject('story.tw', undefined, dir)).toEqual({ results: [] });
});
