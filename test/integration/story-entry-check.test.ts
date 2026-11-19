import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runCheck } from '../../src/cli/check.js';
import { checkFiles } from '../../src/mcp/server.js';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

it.each([
  ['{"format":"Spindle","start":"Hall"}', 'SP004', 'Starting passage "Hall" not found'],
  ['{"format":"Spindle",}', 'SP003', 'Cannot unmarshal "StoryData"'],
  ['{"format":"Spindle","start":42}', 'SP003', '$.start must be a string'],
  ['{"format":"Spindle","ifid":"invalid"}', 'SP003', 'Cannot validate IFID'],
  ['{"format":"Spindle","start":42}\r\n:: StoryData\r\n{"format":"Spindle"}', 'SP003', '$.start must be a string'],
  ['{"format":"Spindle",}\r\n:: StoryData\r\n{"format":"Spindle"}', 'SP003', 'Cannot unmarshal "StoryData"'],
  ['{"format":"Spindle","start":"StoryData"}', 'SP004', 'left out of the story data'],
])('reports missing entry errors through CLI and MCP: %s', async (data, code, message) => {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-story-data-'));
  directories.push(dir);
  const file = join(dir, 'story.tw');
  writeFileSync(file, `:: StoryData\r\n${data}\r\n:: StoryVariables\r\n:: Start\r\nhello`);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runCheck(['--format', 'json', file])).toBe(1);
  const report = JSON.parse(log.mock.calls.map(call => call.join(' ')).join('\n'));
  const diagnostics = report.files.flatMap((entry: { diagnostics: unknown[] }) => entry.diagnostics);
  expect(diagnostics).toContainEqual(expect.objectContaining({ code, severity: 'error', message: expect.stringContaining(message) }));
  expect(await checkFiles('story.tw', undefined, dir)).toContainEqual(expect.objectContaining({ code, severity: 'error', message: expect.stringContaining(message) }));

  writeFileSync(file, ':: StoryData\r\n{"format":"Spindle","start":"Start"}\r\n:: StoryVariables\r\n:: Start\r\nhello');
  expect(await runCheck(['--format', 'json', file])).toBe(0);
  expect(await checkFiles('story.tw', undefined, dir)).toEqual([]);
});

it('reports superseded metadata in its original file through CLI and MCP (#200)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-replaced-data-'));
  directories.push(dir);
  const earlier = join(dir, 'a.tw');
  const replacement = join(dir, 'z.tw');
  writeFileSync(earlier, ':: StoryData\n{"start":42}\n:: StoryVariables\n:: Start\nHello');
  writeFileSync(replacement, ':: StoryData\n{"format":"Spindle"}\n');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runCheck(['--format', 'json', dir])).toBe(1);
  expect(JSON.parse(log.mock.calls.flat().join('\n')).files).toEqual([
    expect.objectContaining({ uri: pathToFileURL(earlier).href, diagnostics: [expect.objectContaining({ code: 'SP003' })] }),
  ]);
  expect(await checkFiles('*.tw', undefined, dir)).toEqual([
    expect.objectContaining({ file: 'a.tw', code: 'SP003', severity: 'error' }),
  ]);

  writeFileSync(earlier, ':: StoryData\n{}\n:: StoryVariables\n:: Start\nHello');
  expect(await runCheck(['--format', 'json', dir])).toBe(0);
  expect(await checkFiles('*.tw', undefined, dir)).toEqual([]);
});

it.each(['script', 'stylesheet', 'Twine.private'])('reports an implicit compiler-omitted Start through CLI and MCP: %s (#208)', async tag => {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-entry-omitted-'));
  directories.push(dir);
  const file = join(dir, 'story.tw');
  writeFileSync(file, `:: StoryVariables\n:: Start [${tag}]\n`);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runCheck(['--format', 'json', file])).toBe(1);
  expect(log.mock.calls.flat().join(' ')).toContain('left out of the story data');
  expect(await checkFiles('story.tw', undefined, dir)).toContainEqual(expect.objectContaining({ code: 'SP004', severity: 'error' }));
});
