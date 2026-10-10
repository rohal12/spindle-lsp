/**
 * Contract Q-format: the formatter protects the spans Spindle's tokenizer
 * executes, and reads them one way in every entry point. Since 0.50.1 braces
 * inside string and template literals do not count; the minimum supported
 * Spindle (0.59.20) reads them like that, so there is no reading to choose and
 * no option to pass. The Spindle version of the project is only used to warn
 * when it is older than the minimum.
 *
 * The oracle is the installed runtime's tokenizer: formatting must keep every
 * macro's payload (`rawArgs`) and the passage's token sequence, and be
 * idempotent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenize } from '../helpers/tooling.js';
import { formatDocument } from '../../src/plugins/format.js';
import { scanSpindleTokens } from '../../src/plugins/format/placeholders.js';
import { findSpindleTarget } from '../../src/core/workspace/story-format.js';
import { checkFormatting, formatFiles } from '../../src/mcp/server.js';
import { runFormat } from '../../src/cli/format.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { MINIMUM_SPINDLE_VERSION } from '../../src/core/workspace/spindle-version.js';

/** The macro payloads and token kinds the installed tokenizer reads, ignoring text. */
function payloads(text: string) {
  return tokenize(text).flatMap(t => (t.type === 'macro' ? [`${t.isClose ? '/' : ''}${t.name}:${t.rawArgs}`] : t.type === 'text' ? [] : [t.type]));
}

const stray = ':: Start\n{if $x}\n{set $s = "{"}\n   keep   this }\nafter\n{/if}\n';
const template = ':: Start\n{if $x}\n{print `a{`}\n   keep   this }\n{/if}\n';

describe('Q-format-oracle: formatting keeps what the installed tokenizer executes', () => {
  for (const [name, text] of [['string with a stray brace', stray], ['template with a stray brace', template]]) {
    for (const eol of ['\n', '\r\n']) {
      it(`Q-format-payload ${name} (${eol === '\n' ? 'LF' : 'CRLF'})`, async () => {
        const source = text.replace(/\n/g, eol);
        const out = await formatDocument(source);
        // Macro payloads are the runtime's arguments: byte-identical (CRLF normalizes to LF in the compiler)
        expect(payloads(out.replace(/\r\n/g, '\n'))).toEqual(payloads(source.replace(/\r\n/g, '\n')));
        // Idempotent
        expect(await formatDocument(out)).toBe(out);
      });
    }
  }

  it('Q-format-scan: the scanned spans are the tokenizer\'s, outside HTML tags', () => {
    for (const text of [stray, template, '{set $s = "{"}\nx {y}', '{print "}"} {z}']) {
      const spans = scanSpindleTokens(text).map(m => [m.start, m.end]);
      const expected = tokenize(text)
        .filter(t => t.type === 'macro' || t.type === 'variable' || t.type === 'expression' || t.type === 'link')
        .map(t => [t.start, t.end]);
      expect(spans, JSON.stringify(text)).toEqual(expected);
    }
  });
});

describe('Q-format-reading: the string is skipped, the macro ends at its own `}`', () => {
  it('Q-format-stray-brace: the prose after a macro with a stray brace in a string is formatted', async () => {
    const out = await formatDocument(stray);
    expect(out).toBe(':: Start\n{if $x}\n  {set $s = "{"}\n  keep   this }\n  after\n{/if}\n');
  });

  it('Q-format-stray-brace-template: the same for a template literal', async () => {
    const out = await formatDocument(template);
    expect(out).toBe(':: Start\n{if $x}\n  {print `a{`}\n  keep   this }\n{/if}\n');
  });
});

describe('Q-format-entrypoints: one reading everywhere; the project\'s Spindle only warns', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function project(installed: string | undefined, storyDataVersion?: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'spindle-lsp-format-'));
    dirs.push(dir);
    if (installed) {
      const pkg = join(dir, 'node_modules', '@rohal12', 'spindle');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@rohal12/spindle', version: installed }));
    }
    const data = storyDataVersion
      ? `:: StoryData\n{"format": "Spindle", "format-version": "${storyDataVersion}"}\n\n` : '';
    writeFileSync(join(dir, 'story.tw'), data + stray);
    return dir;
  }

  const formatted = (out: string) => out.includes('\n  keep   this }\n');

  it('Q-format-target: installed version, then StoryData, then none', async () => {
    const texts = [readFileSync(join(project('0.59.20'), 'story.tw'), 'utf-8')];
    expect(await findSpindleTarget(texts, project('0.59.23'))).toMatchObject({ version: '0.59.23', source: 'installed', supported: true });
    expect(await findSpindleTarget(texts, project('0.59.19'))).toMatchObject({ version: '0.59.19', supported: false });
    // no install: StoryData (own file, or the project's)
    const withData = project(undefined, '0.59.20');
    expect(await findSpindleTarget([readFileSync(join(withData, 'story.tw'), 'utf-8')], withData))
      .toMatchObject({ version: '0.59.20', source: 'story-data', supported: true });
    expect(await findSpindleTarget([], withData)).toMatchObject({ version: '0.59.20', source: 'story-data' });
    expect((await findSpindleTarget([], project(undefined, '0.49.0'))).supported).toBe(false);
    // nothing at all: nothing to warn about
    expect(await findSpindleTarget([], project(undefined))).toMatchObject({ version: undefined, source: 'default', supported: true });
    // the installed version wins over StoryData
    expect((await findSpindleTarget([], project('0.59.21', '0.49.0'))).version).toBe('0.59.21');
  });

  it('Q-format-mcp: spindle_format and spindle_format_check read the same for every release', async () => {
    for (const version of [undefined, '0.59.20', '0.50.0']) {
      const dir = project(version);
      expect((await checkFormatting('**/*.tw', dir)).needsFormatting, String(version)).toEqual(['story.tw']);
      const result = await formatFiles('**/*.tw', dir);
      expect(result.formatted, String(version)).toBe(1);
      expect(formatted(readFileSync(join(dir, 'story.tw'), 'utf-8')), String(version)).toBe(true);
      expect((await checkFormatting('**/*.tw', dir)).needsFormatting).toEqual([]);
    }
  });

  it('Q-format-mcp-warning: a project older than the minimum is told so, and still formatted', async () => {
    const old = project('0.50.0');
    expect((await checkFormatting('**/*.tw', old)).warning).toContain(`older than ${MINIMUM_SPINDLE_VERSION}`);
    expect((await formatFiles('**/*.tw', old)).warning).toContain(`older than ${MINIMUM_SPINDLE_VERSION}`);
    const modern = project('0.59.23');
    expect((await checkFormatting('**/*.tw', modern)).warning).toBeUndefined();
    expect((await formatFiles('**/*.tw', modern)).warning).toBeUndefined();
    expect((await formatFiles('**/*.tw', project(undefined))).warning).toBeUndefined();
  });

  it('Q-format-cli: spindle-lsp format reads the same for every release and warns below the minimum', async () => {
    const quiet = async (args: string[]) => {
      const log = console.log;
      const error = console.error;
      const errors: string[] = [];
      console.log = () => {};
      console.error = (...message: unknown[]) => { errors.push(message.join(' ')); };
      try { return { code: await runFormat(args), errors }; } finally { console.log = log; console.error = error; }
    };
    for (const version of ['0.59.23', '0.50.0']) {
      const dir = project(version);
      const file = join(dir, 'story.tw');
      expect((await quiet(['--check', file])).code).toBe(1);
      const run = await quiet([file]);
      expect(run.code).toBe(0);
      expect(run.errors.some(e => e.includes(`older than ${MINIMUM_SPINDLE_VERSION}`)), version).toBe(version === '0.50.0');
      expect(formatted(readFileSync(file, 'utf-8'))).toBe(true);
      expect((await quiet(['--check', file])).code).toBe(0);
    }
  });

  it('Q-format-lsp: the formatting request reads the same, with the workspace\'s block macros', async () => {
    for (const version of ['0.59.20', '0.59.23']) {
      const workspace = new WorkspaceModel({ workspaceRoot: project(version) });
      const options = { isBlock: (name: string) => workspace.isContainer(name) };
      expect(formatted(await formatDocument(stray, options)), version).toBe(true);
      workspace.dispose();
    }
  });
});
