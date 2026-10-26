import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCheck } from '../../src/cli/check.js';
import { checkFiles } from '../../src/mcp/server.js';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

it.each(['listbox', 'cycle'])('accepts %s options with a same-named widget through CLI and MCP (#207)', async control => {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-control-options-'));
  directories.push(dir);
  const file = join(dir, 'story.tw');
  const text = ':: StoryVariables\r\n$x = "A"\r\n:: Widgets [widget]\r\n'
    + '{widget "option" @value}Widget:{@value}{/widget}\r\n:: Start\r\n'
    + `{option "standalone"}\r\n{${control} "$x"}{option "A"}{option "B"}{/${control}}\r\n`;
  writeFileSync(file, text);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runCheck(['--format', 'json', file])).toBe(0);
  expect(JSON.parse(log.mock.calls.flat().join('\n'))).toEqual({ files: [] });
  expect(await checkFiles('story.tw', undefined, dir)).toEqual([]);

  writeFileSync(file, text.replace('{option "A"}{option "B"}', ''));
  expect(await runCheck(['--format', 'json', file])).toBe(1);
  expect(await checkFiles('story.tw', undefined, dir)).toContainEqual(
    expect.objectContaining({ code: 'SP115', severity: 'error' }),
  );
});
