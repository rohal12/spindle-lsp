/**
 * Contract Q-format: the formatter protects the spans the target Spindle's
 * tokenizer executes, and the tokenizer changed in 0.50.1 (braces inside
 * string and template literals no longer count). The formatter follows the
 * target release (`SpindleCapabilities.stringAwareBraces`) in every entry
 * point: the LSP (workspace capabilities), the CLI and the MCP tools (the
 * installed `@rohal12/spindle`, else StoryData's `format-version`).
 *
 * The oracle is the installed runtime's tokenizer: formatting must keep every
 * macro's payload (`rawArgs`) and the passage's token sequence, and be
 * idempotent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenize } from '../../node_modules/@rohal12/spindle/src/markup/tokenizer.js';
import { formatDocument } from '../../src/plugins/format.js';
import { scanSpindleTokens } from '../../src/plugins/format/placeholders.js';
import { findSpindleCapabilities } from '../../src/core/workspace/story-format.js';
import { checkFormatting, formatFiles } from '../../src/mcp/server.js';
import { runFormat } from '../../src/cli/format.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { INSTALLED_CAPABILITIES } from '../helpers/spindle-version.js';

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
        const out = await formatDocument(source, { stringAwareBraces: INSTALLED_CAPABILITIES.stringAwareBraces });
        // Macro payloads are the runtime's arguments: byte-identical (CRLF normalizes to LF in the compiler)
        expect(payloads(out.replace(/\r\n/g, '\n'))).toEqual(payloads(source.replace(/\r\n/g, '\n')));
        // Idempotent
        expect(await formatDocument(out, { stringAwareBraces: INSTALLED_CAPABILITIES.stringAwareBraces })).toBe(out);
      });
    }
  }

  it('Q-format-wrong-reading: the other reading formats differently (the test is not vacuous)', async () => {
    const right = await formatDocument(stray, { stringAwareBraces: INSTALLED_CAPABILITIES.stringAwareBraces });
    const wrong = await formatDocument(stray, { stringAwareBraces: !INSTALLED_CAPABILITIES.stringAwareBraces });
    expect(wrong).not.toBe(right);
    // Before 0.50.1 the wrong (string-aware) reading re-indents text inside the macro's payload
    if (!INSTALLED_CAPABILITIES.stringAwareBraces) expect(payloads(wrong)).not.toEqual(payloads(stray));
  });

  it('Q-format-scan: the scanned spans are the tokenizer\'s, outside HTML tags', () => {
    for (const text of [stray, template, '{set $s = "{"}\nx {y}', '{print "}"} {z}']) {
      const spans = scanSpindleTokens(text, INSTALLED_CAPABILITIES).map(m => [m.start, m.end]);
      const expected = tokenize(text)
        .filter(t => t.type === 'macro' || t.type === 'variable' || t.type === 'expression' || t.type === 'link')
        .map(t => [t.start, t.end]);
      expect(spans, JSON.stringify(text)).toEqual(expected);
    }
  });
});

describe('Q-format-versions: the two readings, stated', () => {
  it('Q-format-0.50.0: a stray brace in a string extends the macro to the next `}`', async () => {
    const out = await formatDocument(stray);
    expect(out).toBe(':: Start\n{if $x}\n  {set $s = "{"}\n   keep   this }\n  after\n{/if}\n');
  });

  it('Q-format-0.50.1: the string is skipped, the macro ends at its own `}`', async () => {
    const out = await formatDocument(stray, { stringAwareBraces: true });
    expect(out).toBe(':: Start\n{if $x}\n  {set $s = "{"}\n  keep   this }\n  after\n{/if}\n');
  });
});

describe('Q-format-entrypoints: the target release comes from the project', () => {
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
    writeFileSync(join(dir, 'story.tw'), data + stray.replace(':: Start\n', ':: Start\n'));
    return dir;
  }

  const plain = (out: string) => out.includes('\n   keep   this }\n');
  const aware = (out: string) => out.includes('\n  keep   this }\n');

  it('Q-format-capabilities: installed version, then StoryData, then the default', async () => {
    const texts = [readFileSync(join(project('0.50.1'), 'story.tw'), 'utf-8')];
    expect((await findSpindleCapabilities(texts, project('0.50.1'))).stringAwareBraces).toBe(true);
    expect((await findSpindleCapabilities(texts, project('0.50.0'))).stringAwareBraces).toBe(false);
    expect((await findSpindleCapabilities(texts, project('0.45.1'))).version).toBe('0.45.1');
    // no install: StoryData (own file, or the project's)
    const withData = project(undefined, '0.51.0');
    expect((await findSpindleCapabilities([readFileSync(join(withData, 'story.tw'), 'utf-8')], withData)).stringAwareBraces).toBe(true);
    expect((await findSpindleCapabilities([], withData)).stringAwareBraces).toBe(true);
    const old = project(undefined, '0.49.0');
    expect((await findSpindleCapabilities([], old)).stringAwareBraces).toBe(false);
    // nothing at all: the Spindle 0.45.1 behavior
    const none = project(undefined);
    expect(await findSpindleCapabilities([], none)).toMatchObject({ source: 'default', stringAwareBraces: false });
    // the installed version wins over StoryData
    const both = project('0.50.0', '0.51.3');
    expect((await findSpindleCapabilities([], both)).version).toBe('0.50.0');
  });

  it('Q-format-mcp: spindle_format and spindle_format_check follow the installed release', async () => {
    const old = project('0.50.0');
    expect((await checkFormatting('**/*.tw', old)).needsFormatting).toEqual(['story.tw']);
    expect((await formatFiles('**/*.tw', old)).formatted).toBe(1);
    expect(plain(readFileSync(join(old, 'story.tw'), 'utf-8'))).toBe(true);
    // formatted by its own release: nothing more to do
    expect((await checkFormatting('**/*.tw', old)).needsFormatting).toEqual([]);

    const modern = project('0.51.3');
    expect((await formatFiles('**/*.tw', modern)).formatted).toBe(1);
    expect(aware(readFileSync(join(modern, 'story.tw'), 'utf-8'))).toBe(true);
    expect((await checkFormatting('**/*.tw', modern)).needsFormatting).toEqual([]);

    // by StoryData when nothing is installed
    const declared = project(undefined, '0.50.1');
    await formatFiles('**/*.tw', declared);
    expect(aware(readFileSync(join(declared, 'story.tw'), 'utf-8'))).toBe(true);
  });

  it('Q-format-cli: spindle-lsp format reads the release the same way', async () => {
    const quiet = async (args: string[]) => {
      const log = console.log;
      console.log = () => {};
      try { return await runFormat(args); } finally { console.log = log; }
    };
    const old = project('0.50.0');
    expect(await quiet(['--check', join(old, 'story.tw')])).toBe(1);
    expect(await quiet([join(old, 'story.tw')])).toBe(0);
    expect(plain(readFileSync(join(old, 'story.tw'), 'utf-8'))).toBe(true);
    expect(await quiet(['--check', join(old, 'story.tw')])).toBe(0);

    const modern = project('0.50.1');
    expect(await quiet([join(modern, 'story.tw')])).toBe(0);
    expect(aware(readFileSync(join(modern, 'story.tw'), 'utf-8'))).toBe(true);
    expect(await quiet(['--check', join(modern, 'story.tw')])).toBe(0);
  });

  it('Q-format-lsp: the formatting request follows the workspace capabilities', async () => {
    for (const [version, check] of [['0.50.0', plain], ['0.50.1', aware]] as const) {
      const root = project(version);
      const workspace = new WorkspaceModel({ workspaceRoot: root });
      const options = {
        isBlock: (name: string) => workspace.isContainer(name),
        get stringAwareBraces() { return workspace.capabilities.stringAwareBraces; },
      };
      expect(check(await formatDocument(stray, options)), version).toBe(true);
      workspace.dispose();
    }
  });
});
