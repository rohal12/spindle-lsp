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

it.each(['$', '%'])('accounts for %s root reassignment in CLI and MCP checks (#211)', async sigil => {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-array-reassignment-'));
  directories.push(dir);
  const file = join(dir, 'story.tw');
  const declaration = sigil === '$' ? ':: StoryVariables\n$arr = []\n' : ':: StoryVariables\n:: StoryTransients\n%arr = []\n';
  const source = `${declaration}:: Start\n{set ${sigil}arr = {foo:7}}{${sigil}arr.foo}\n`;
  writeFileSync(file, source);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runCheck(['--format', 'json', file])).toBe(0);
  expect(JSON.parse(log.mock.calls.flat().join('\n'))).toEqual({ files: [] });
  expect(await checkFiles('story.tw', undefined, dir)).toEqual([]);

  writeFileSync(file, source.replace(`{set ${sigil}arr = {foo:7}}`, ''));
  log.mockClear();
  await runCheck(['--format', 'json', file]);
  const report = JSON.parse(log.mock.calls.flat().join('\n'));
  expect(report.files.flatMap((entry: { diagnostics: unknown[] }) => entry.diagnostics)).toContainEqual(
    expect.objectContaining({ code: 'SP206', severity: 'warning' }),
  );
  expect(await checkFiles('story.tw', undefined, dir)).toContainEqual(
    expect.objectContaining({ code: 'SP206', severity: 'warning' }),
  );
});
