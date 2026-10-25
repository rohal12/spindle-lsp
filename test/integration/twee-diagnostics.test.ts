import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTwee } from '@rohal12/twee-ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildDist, type DistBuild } from './support/dist-build.js';

let dist: DistBuild;
let directory: string;
beforeAll(() => { dist = buildDist(); });
afterAll(() => dist?.dispose());
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spindle-twee-diagnostics-'));
  writeFileSync(join(directory, 'package.json'), '{}');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it.each([':: Broken [', '::', ':: Broken {', ':: Valid\\[Name', ':: Valid {oops}'])(
  'CLI and MCP preserve compiler header-error behavior for %s (#197)', async header => {
    const source = `:: StoryVariables\r\n:: Start\r\nhello\r\n${header}\r\ntext\r\n`;
    writeFileSync(join(directory, 'story.tw'), source);
    const errors = parseTwee(source).diagnostics.filter(d => d.level === 'error');
    const result = spawnSync(process.execPath, [dist.executable, 'check', '--format', 'json', 'story.tw'], {
      cwd: directory, encoding: 'utf8', timeout: 10000,
    });
    expect(result.status, result.stderr).toBe(errors.length ? 1 : 0);
    const files = JSON.parse(result.stdout).files;
    expect(files.flatMap((f: any) => f.diagnostics).filter((d: any) => d.code === 'SP002'))
      .toEqual(errors.map(d => ({
        code: 'SP002', severity: 'error', source: 'spindle', message: d.message,
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: header.length } },
      })));

    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [dist.executable, 'mcp'], cwd: directory,
      env: { ...process.env } as Record<string, string>, stderr: 'ignore',
    }));
    try {
      const response = await client.callTool({ name: 'spindle_check', arguments: { path: 'story.tw' } });
      expect(response.isError).toBeFalsy();
      const body = JSON.parse((response.content as { text: string }[])[0].text);
      expect(body.filter((d: any) => d.code === 'SP002')).toEqual(errors.map(d => ({
        file: 'story.tw', line: 4, column: 1, code: 'SP002', severity: 'error', message: d.message,
      })));
    } finally { await client.close(); }
  },
);
