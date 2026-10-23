import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheck } from '../../src/cli/check.js';
import { checkFiles } from '../../src/mcp/server.js';

interface ResultDiagnostic { code: string; message: string }

let directory: string;
let storyFile: string;
let configFile: string;

const config = { macros: { caption: { parameters: ['string'] } } };
const story = `:: StoryVariables
$rows = []
:: Macros [script]
for (const name of ["caption"]) {
  Story.defineMacro({
    name,
    parameters: [{ name: "value", type: "string" }],
    render(props, ctx) { return "literal:" + ctx.args.value; }
  });
}
:: W [widget]
{widget "caption" @value:markup}{@value}{/widget}
:: Start
{caption "{$rows.noSuchMember}"}
`;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spindle-issue-161-'));
  // Keep project discovery inside the fixture even on hosts with /tmp/node_modules.
  writeFileSync(join(directory, 'package.json'), '{}');
  storyFile = join(directory, 'story.twee');
  configFile = join(directory, 'spindle.config.json');
  writeFileSync(storyFile, story);
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

async function cliDiagnostics(explicitConfig: boolean): Promise<ResultDiagnostic[]> {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
  try {
    const args = ['--format', 'json', storyFile];
    if (explicitConfig) args.push('--config', configFile);
    expect(await runCheck(args)).toBe(0);
    const result: { files: Array<{ diagnostics: ResultDiagnostic[] }> } = JSON.parse(output.join('\n'));
    return result.files.flatMap(file => file.diagnostics);
  } finally {
    console.log = originalLog;
  }
}

describe.each([
  { name: 'CLI project config', check: () => cliDiagnostics(false) },
  { name: 'CLI explicit config', check: () => cliDiagnostics(true) },
  { name: 'MCP project config', check: () => checkFiles(storyFile, undefined, directory) },
])('$name initializes analysis with config (#161)', ({ check }) => {
  it('does not read a string argument as the shadowed widget markup', async () => {
    writeFileSync(configFile, JSON.stringify(config));
    expect(await check()).toEqual([]);
  });

  it('still reads the widget markup when config does not define a macro', async () => {
    writeFileSync(configFile, JSON.stringify({ macros: {} }));
    const diagnostics = await check();
    expect(diagnostics.filter(diagnostic => diagnostic.code === 'SP206')).toHaveLength(1);
    expect(diagnostics.find(diagnostic => diagnostic.code === 'SP206')?.message).toContain('$rows.noSuchMember');
  });

  it('recognizes ordinary configured macros and retains real variable reads', async () => {
    writeFileSync(configFile, JSON.stringify(config));
    writeFileSync(storyFile, ':: StoryVariables\n$rows = []\n:: Start\n{caption "literal"}\n{$rows.noSuchMember}\n');
    const diagnostics = await check();
    expect(diagnostics.filter(diagnostic => diagnostic.code === 'SP100')).toEqual([]);
    expect(diagnostics.filter(diagnostic => diagnostic.code === 'SP206')).toHaveLength(1);
    expect(diagnostics.find(diagnostic => diagnostic.code === 'SP206')?.message).toContain('$rows.noSuchMember');
  });
});
