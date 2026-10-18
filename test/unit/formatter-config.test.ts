import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatDocument } from '../../src/plugins/format.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spindle-formatter-config-'));
  writeFileSync(join(directory, 'package.json'), '{}');
  vi.stubEnv('SPINDLE_LSP_TRUSTED_FORMAT', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

const source = ':: Code [script]\nconst x="hello";\nif(x){console.log(x)}\n';
const format = (text = source) => formatDocument(text, { filePath: pathToFileURL(join(directory, 'story.tw')).href });
const markerCode = `require('node:fs').writeFileSync(__dirname + '/marker', 'executed');\n`;

describe('formatter host trust (#128)', () => {
  it('does not execute JavaScript config without formatter trust, even with play trusted', async () => {
    vi.stubEnv('SPINDLE_LSP_TRUSTED_PLAY', '1');
    writeFileSync(join(directory, '.prettierrc.cjs'), markerCode + 'module.exports = { singleQuote: true };');
    expect(await format()).toContain('const x = "hello";');
    expect(existsSync(join(directory, 'marker'))).toBe(false);
  });

  it('allows executable config with explicit host formatter trust', async () => {
    vi.stubEnv('SPINDLE_LSP_TRUSTED_FORMAT', '1');
    writeFileSync(join(directory, '.prettierrc.cjs'), markerCode + 'module.exports = { singleQuote: true };');
    expect(await format()).toContain("const x = 'hello';");
    expect(existsSync(join(directory, 'marker'))).toBe(true);
  });

  it.each(['plugin', 'shared'])('allows a trusted %s module', async kind => {
    vi.stubEnv('SPINDLE_LSP_TRUSTED_FORMAT', '1');
    writeFileSync(join(directory, 'module.cjs'), markerCode + 'module.exports = { singleQuote: true };');
    writeFileSync(join(directory, '.prettierrc.json'), JSON.stringify(kind === 'shared'
      ? './module.cjs' : { singleQuote: true, plugins: ['./module.cjs'] }));
    expect(await format()).toContain("const x = 'hello';");
    expect(existsSync(join(directory, 'marker'))).toBe(true);
  });

  it.each(['.prettierrc.json', '.prettierrc.yaml', '.prettierrc', 'package.json', 'package.yaml'])(
    'keeps data options but never loads plugins from %s', async (name) => {
      const options = { singleQuote: true, plugins: ['./plugin.cjs'] };
      writeFileSync(join(directory, name), JSON.stringify(name.startsWith('package.') ? { prettier: options } : options));
      writeFileSync(join(directory, 'plugin.cjs'), markerCode + 'module.exports = {};');
      expect(await format()).toContain("const x = 'hello';");
      expect(existsSync(join(directory, 'marker'))).toBe(false);
    },
  );

  it.each(['.prettierrc.json', '.prettierrc', 'package.json'])(
    'does not import a shareable config named by %s', async (name) => {
      writeFileSync(join(directory, 'shared.cjs'), markerCode + 'module.exports = {};');
      writeFileSync(join(directory, name), JSON.stringify(name === 'package.json' ? { prettier: './shared.cjs' } : './shared.cjs'));
      await format();
      expect(existsSync(join(directory, 'marker'))).toBe(false);
    },
  );

  it('applies matching data overrides and excludes their plugins', async () => {
    writeFileSync(join(directory, '.prettierrc.json'), JSON.stringify({
      overrides: [
        { files: '*.tw', options: { singleQuote: true, plugins: ['./plugin.cjs'] } },
        { files: '*.tw', excludeFiles: 'story.tw', options: { singleQuote: false } },
      ],
    }));
    writeFileSync(join(directory, 'plugin.cjs'), markerCode + 'module.exports = {};');
    expect(await format()).toContain("const x = 'hello';");
    expect(existsSync(join(directory, 'marker'))).toBe(false);
  });

  it('matches basename overrides in hidden directories for unopened documents', async () => {
    writeFileSync(join(directory, '.prettierrc.yaml'), 'overrides:\n  - files: "*.tw"\n    options:\n      singleQuote: true\n');
    const output = await formatDocument(source, { filePath: join(directory, '.stories', '.draft.tw') });
    expect(output).toContain("const x = 'hello';");
  });

  it.each([
    ['*.tw', '*.tw', false],
    ['stories/*.tw', '*.tw', true],
    ['stories/*.tw', 'stories/*.tw', false],
    ['*.tw', 'stories/*.tw', false],
  ] as const)('matches files=%s excludeFiles=%s like Prettier', async (files, excludeFiles, matches) => {
    writeFileSync(join(directory, '.prettierrc.json'), JSON.stringify({
      overrides: [{ files, excludeFiles, options: { singleQuote: true } }],
    }));
    const output = await formatDocument(source, { filePath: join(directory, 'stories', 'scene.tw') });
    expect(output).toContain(matches ? "const x = 'hello';" : 'const x = "hello";');
  });
});

describe('formatter EOL convergence (#129)', () => {
  for (const eol of ['\n', '\r\n']) {
    it.each(['lf', 'crlf', 'cr', 'auto'])(`preserves document EOL ${JSON.stringify(eol)} with Prettier endOfLine=%s`, async (endOfLine) => {
      writeFileSync(join(directory, '.prettierrc.json'), JSON.stringify({ endOfLine }));
      const text = (source + '\n:: Style [stylesheet]\n.x{color:red}\n\n:: Start\n<div>\n<p>hello</p>\n</div>\n').replaceAll('\n', eol);
      const output = await format(text);
      expect(output).toContain(`const x = "hello";${eol}if (x) {${eol}  console.log(x);${eol}}`);
      expect(output.replaceAll(eol, '')).not.toMatch(/[\r\n]/);
      expect(await format(output)).toBe(output);
    });
  }
});
