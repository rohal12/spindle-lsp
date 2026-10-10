import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runCheck } from '../../src/cli/check.js';

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');

// Helper: capture stdout during a function call
async function captureStdout(fn: () => Promise<number>): Promise<{ exitCode: number; output: string }> {
  const writes: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    writes.push(args.map(String).join(' '));
  };
  try {
    const exitCode = await fn();
    return { exitCode, output: writes.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

// Helper: capture stdout and stderr during a function call
async function captureOutput(fn: () => Promise<number>): Promise<{ exitCode: number; output: string; errors: string }> {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    const result = await captureStdout(fn);
    return { ...result, errors: errors.join('\n') };
  } finally {
    console.error = originalError;
  }
}

describe('CLI check command', () => {
  it('returns 0 for valid story', async () => {
    const validFile = join(fixturesDir, 'valid-story.tw');
    const { exitCode } = await captureStdout(() => runCheck([validFile]));
    expect(exitCode).toBe(0);
  });

  it('returns 1 for story with errors', async () => {
    const errorFile = join(fixturesDir, 'errors.tw');
    const { exitCode } = await captureStdout(() => runCheck([errorFile]));
    expect(exitCode).toBe(1);
  });

  it('outputs valid JSON with --format json', async () => {
    const validFile = join(fixturesDir, 'valid-story.tw');
    const { exitCode, output } = await captureStdout(() =>
      runCheck(['--format', 'json', validFile]),
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('files');
    expect(Array.isArray(parsed.files)).toBe(true);
  });

  it('outputs valid JSON with errors in --format json', async () => {
    const errorFile = join(fixturesDir, 'errors.tw');
    const { exitCode, output } = await captureStdout(() =>
      runCheck(['--format', 'json', errorFile]),
    );
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(output);
    expect(parsed.files.length).toBeGreaterThan(0);
    expect(parsed.files[0].diagnostics.length).toBeGreaterThan(0);
  });

  it('outputs valid SARIF with --format sarif', async () => {
    const errorFile = join(fixturesDir, 'errors.tw');
    const { output } = await captureStdout(() =>
      runCheck(['--format', 'sarif', errorFile]),
    );
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('$schema');
    expect(parsed.version).toBe('2.1.0');
    expect(parsed).toHaveProperty('runs');
    expect(Array.isArray(parsed.runs)).toBe(true);
    expect(parsed.runs[0]).toHaveProperty('tool');
    expect(parsed.runs[0]).toHaveProperty('results');
  });

  it('returns 0 when no files match', async () => {
    const { exitCode } = await captureStdout(() =>
      runCheck(['nonexistent-pattern-*.xyz']),
    );
    expect(exitCode).toBe(0);
  });

  it('pretty reporter includes problem count', async () => {
    const errorFile = join(fixturesDir, 'errors.tw');
    const { output } = await captureStdout(() =>
      runCheck(['--format', 'pretty', errorFile]),
    );
    expect(output).toContain('Found');
    expect(output).toContain('problem');
  });

  it('reports runtime pitfalls (SP205, SP206, SP302, SP303) at their severities', async () => {
    const file = join(fixturesDir, 'runtime-pitfalls.tw');
    const { exitCode, output } = await captureStdout(() =>
      runCheck(['--format', 'json', '--severity', 'hint', file]),
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    const diags: Array<{ code: string; severity: string; message: string }> = parsed.files[0].diagnostics;
    const byCode = (code: string) => diags.filter(d => d.code === code);

    expect(byCode('SP205')).toHaveLength(1);
    expect(byCode('SP205')[0].message).toContain("'_b'");
    expect(byCode('SP206')).toHaveLength(1);
    expect(byCode('SP206')[0].message).toContain('$flags.discovered_corruption');
    expect(byCode('SP302')).toHaveLength(1);
    expect(byCode('SP302')[0].message).toContain('{ActResist}');
    expect(byCode('SP303')).toHaveLength(1);
    expect(byCode('SP303')[0]).toMatchObject({ severity: 'hint' });
    expect(byCode('SP303')[0].message).toContain('"ActResist"');
  });

  it('accepts {next} branches with delays inside {timed}', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spindle-cli-timed-'));
    try {
      const file = join(dir, 'story.twee');
      writeFileSync(file, ':: Start\n{timed 1s}\nFirst\n{next 2s}\nSecond\n{/timed}\n');
      const { exitCode, output } = await captureStdout(() => runCheck(['--format', 'json', file]));
      expect(exitCode).toBe(0);
      expect(JSON.parse(output).files).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports undeclared variables in StoryInit, interpolations and receivers, not prose or string literals (#62)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spindle-cli-undeclared-'));
    try {
      const file = join(dir, 'story.twee');
      writeFileSync(file, [
        ':: StoryVariables',
        '$x = 1',
        ':: StoryInit',
        '{set $missingInit = 2}',
        ':: Start',
        '{print `${$missingTemplate}`}',
        '{textbox "$missingReceiver"}',
        '{print $missingCode}',
        'It costs $missingProse today.',
        '{print "costs $missingLiteral"}',
        '',
      ].join('\n'));
      const { exitCode, output } = await captureStdout(() => runCheck(['--format', 'json', file]));
      expect(exitCode).toBe(1);
      const diags: Array<{ code: string; message: string }> = JSON.parse(output).files[0].diagnostics;
      const names = diags
        .filter(d => d.code === 'SP200')
        .map(d => /\$(\w+)$/.exec(d.message)?.[1]);
      // Spindle validates the variables the code reads: `$missingProse` is
      // text and `$missingLiteral` is inside a string literal
      expect(names).toEqual(['missingInit', 'missingTemplate', 'missingReceiver', 'missingCode']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads macros and expressions in HTML attributes as markup (#63)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spindle-cli-attributes-'));
    try {
      const file = join(dir, 'story.twee');
      writeFileSync(file, [
        ':: StoryVariables',
        '$n = 1',
        ':: Start',
        '{set @d = {delta: $n}}',
        '<span class="{if @d.delta > 0}delta-positive{else}delta-negative{/if}">x</span>',
        `<span class="{$n > 0 ? 'pos' : 'neg'}">y</span>`,
        `<span class="{!$n ? 'zero' : 'nonzero'}">z</span>`,
        `<span data-x='{"a":1}'>j</span>`,
        '',
      ].join('\n'));
      const { exitCode, output } = await captureStdout(() => runCheck(['--format', 'json', file]));
      // The value of an attribute holds markup: Spindle evaluates the {if}, and the `{!$n ? …}` expression too,
      // so there is nothing to warn about (the SP103 of earlier releases is gone)
      expect(exitCode).toBe(0);
      expect(JSON.parse(output).files).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hides the SP303 hint at --severity warning', async () => {
    const file = join(fixturesDir, 'runtime-pitfalls.tw');
    const { output } = await captureStdout(() =>
      runCheck(['--format', 'json', '--severity', 'warning', file]),
    );
    const codes = JSON.parse(output).files[0].diagnostics.map((d: { code: string }) => d.code);
    expect(codes).not.toContain('SP303');
    expect(codes).toEqual(expect.arrayContaining(['SP205', 'SP206', 'SP302']));
  });
});

describe('CLI check custom macro sources (#47)', () => {
  it('discovers macros from JS/TS files in the project, skipping dependencies and build output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spindle-cli-macros-'));
    const files: Record<string, string> = {
      'package.json': '{}\n',
      'src/story/Start.twee': ':: Start\n{hello}\n{greet}\n{vendored}\n{bundled}\n',
      'src/assets/app/index.ts': 'Story.defineMacro({ name: "greet", render(): null { return null; } });\n',
      'macros.js': 'Story.defineMacro({ name: "hello", render() { return null; } });\n',
      'node_modules/some-lib/index.js': 'Story.defineMacro({ name: "vendored", render() { return null; } });\n',
      'dist/scripts/app.bundle.js': 'Story.defineMacro({ name: "bundled", render() { return null; } });\n',
    };
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const { output } = await captureStdout(() => runCheck(['--format', 'json']));
      const parsed = JSON.parse(output);
      // Macro sources are loaded for discovery, not reported on
      expect(parsed.files.map((f: { uri: string }) => f.uri.split('/').pop())).toEqual(['Start.twee']);
      const sp100 = parsed.files[0].diagnostics
        .filter((d: { code: string }) => d.code === 'SP100')
        .map((d: { message: string }) => d.message);
      expect(sp100).toEqual([
        'Unknown macro {vendored}.',
        'Unknown macro {bundled}.',
      ]);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('searches the checked files\' project, regardless of cwd', () => {
    // <home>/projects/game is the project (package.json); its sibling
    // projects/other and the stray file in <home> are unrelated to it.
    const files: Record<string, string> = {
      'Downloads/stray.js': 'Story.defineMacro({ name: "stray", render() { return null; } });\n',
      'projects/other/m.js': 'Story.defineMacro({ name: "bye", render() { return null; } });\n',
      'projects/game/package.json': '{}\n',
      'projects/game/scripts/macros.js': 'Story.defineMacro({ name: "hello", render() { return null; } });\n',
      'projects/game/story/a.tw': ':: Start\n{hello}\n{bye}\n{stray}\n',
    };
    let home: string;
    let outside: string;
    const originalCwd = process.cwd();

    beforeAll(() => {
      home = realpathSync(mkdtempSync(join(tmpdir(), 'spindle-cli-root-')));
      outside = realpathSync(mkdtempSync(join(tmpdir(), 'spindle-cli-elsewhere-')));
      for (const [name, content] of Object.entries(files)) {
        mkdirSync(join(home, name, '..'), { recursive: true });
        writeFileSync(join(home, name), content);
      }
    });

    afterAll(() => {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });

    async function checkFrom(cwd: string, file: string): Promise<string> {
      process.chdir(cwd);
      try {
        return (await captureStdout(() => runCheck(['--format', 'json', file]))).output;
      } finally {
        process.chdir(originalCwd);
      }
    }

    function sp100(output: string): string[] {
      const parsed = JSON.parse(output);
      expect(parsed.files).toHaveLength(1);
      return parsed.files[0].diagnostics
        .filter((d: { code: string }) => d.code === 'SP100')
        .map((d: { message: string }) => d.message);
    }

    const expected = ['Unknown macro {bye}. Did you mean {type}?', 'Unknown macro {stray}.'];

    it('from the project\'s parent directory', async () => {
      expect(sp100(await checkFrom(join(home, 'projects'), 'game/story/a.tw'))).toEqual(expected);
    });

    it('from a subdirectory of the project', async () => {
      expect(sp100(await checkFrom(join(home, 'projects/game/story'), 'a.tw'))).toEqual(expected);
    });

    it('from a distant ancestor (e.g. $HOME)', async () => {
      expect(sp100(await checkFrom(home, 'projects/game/story/a.tw'))).toEqual(expected);
    });

    it('from an unrelated directory', async () => {
      expect(sp100(await checkFrom(outside, join(home, 'projects/game/story/a.tw')))).toEqual(expected);
    });

    it('with identical output from every cwd', async () => {
      const outputs = [
        await checkFrom(join(home, 'projects'), 'game/story/a.tw'),
        await checkFrom(join(home, 'projects/game/story'), 'a.tw'),
        await checkFrom(home, 'projects/game/story/a.tw'),
        await checkFrom(outside, join(home, 'projects/game/story/a.tw')),
      ];
      expect(new Set(outputs).size).toBe(1);
    });
  });
});

describe('CLI check --config', () => {
  function withProject(files: Record<string, string>, fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'spindle-cli-config-'));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  const sp100For = (output: string): string[] =>
    JSON.parse(output).files.flatMap((f: { diagnostics: Array<{ code: string; message: string }> }) =>
      f.diagnostics.filter(d => d.code === 'SP100').map(d => d.message));

  it('loads a config file with a nonstandard name', () =>
    withProject({
      'custom.json': '{"macros":{"custom":{"parameters":[]}}}',
      'story.twee': ':: Start\n{custom}\n',
    }, async (dir) => {
      const { exitCode, output } = await captureStdout(() =>
        runCheck(['--config', join(dir, 'custom.json'), '--format', 'json', join(dir, 'story.twee')]),
      );
      expect(exitCode).toBe(0);
      expect(sp100For(output)).toEqual([]);
    }));

  it('prefers the explicit file over a standard config in the same directory', () =>
    withProject({
      'custom.yaml': 'macros:\n  custom:\n    parameters: []\n',
      'spindle.config.yaml': 'macros:\n  other:\n    parameters: []\n',
      'story.twee': ':: Start\n{custom}\n{other}\n',
    }, async (dir) => {
      const { output } = await captureStdout(() =>
        runCheck(['--config', join(dir, 'custom.yaml'), '--format', 'json', join(dir, 'story.twee')]),
      );
      expect(sp100For(output)).toEqual(['Unknown macro {other}.']);
    }));

  it('applies discovered macros, with config taking precedence', () =>
    withProject({
      'custom.yaml': 'macros:\n  box:\n    container: false\n',
      'story.twee': ':: StoryInit\n{do}\nStory.defineMacro({ name: "box", block: true, render: () => null});\nStory.defineMacro({ name: "hello", render: () => null});\n{/do}\n\n:: Start\n{hello}\n{box}\n',
    }, async (dir) => {
      const { exitCode, output } = await captureStdout(() =>
        runCheck(['--config', join(dir, 'custom.yaml'), '--format', 'json', join(dir, 'story.twee')]),
      );
      // {box} would be a malformed container (SP101) if discovery won over config
      expect(exitCode).toBe(0);
      expect(JSON.parse(output).files).toEqual([]);
    }));

  it('fails with a clear error for a missing config file', () =>
    withProject({
      'spindle.config.json': '{"macros":{"custom":{}}}',
      'story.twee': ':: Start\n{custom}\n',
    }, async (dir) => {
      const missing = join(dir, 'missing.json');
      const { exitCode, errors } = await captureOutput(() =>
        runCheck(['--config', missing, '--format', 'json', join(dir, 'story.twee')]),
      );
      expect(exitCode).toBe(2);
      expect(errors).toContain(missing);
    }));

  it('fails with a clear error for an invalid config file', () =>
    withProject({
      'custom.json': '{"macros": {',
      'story.twee': ':: Start\n',
    }, async (dir) => {
      const { exitCode, errors } = await captureOutput(() =>
        runCheck(['--config', join(dir, 'custom.json'), join(dir, 'story.twee')]),
      );
      expect(exitCode).toBe(2);
      expect(errors).toContain('custom.json');
    }));
});

describe('CLI check on a story in another format', () => {
  // A SugarCube story: the </b> is a stray closing tag (SP102) in Spindle
  const storyData = (format: string) =>
    `:: StoryData\n{\n\t"ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC",\n\t"format": "${format}"\n}\n`;
  const act = ':: Start\n<<if $gold > 5>>Rich<</if>></b>\n{nope}\n[[Missing]]\n';
  let dir: string;
  const originalCwd = process.cwd();

  function project(format: string): void {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'spindle-cli-format-')));
    const files: Record<string, string> = {
      'package.json': '{}\n',
      'src/story/StoryData.twee': storyData(format),
      'src/story/Act1.twee': act,
    };
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
  }

  async function check(args: string[], cwd = dir) {
    process.chdir(cwd);
    try {
      return await captureOutput(() => runCheck(args));
    } finally {
      process.chdir(originalCwd);
    }
  }

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports nothing, says why and exits 0 (pretty)', async () => {
    project('SugarCube');
    const { exitCode, output, errors } = await check([]);
    expect(exitCode).toBe(0);
    expect(output).toContain('No problems found');
    expect(errors).toBe('Skipped: story format is SugarCube, not Spindle');
  });

  it('prints valid empty JSON and SARIF', async () => {
    project('SugarCube');
    const json = await check(['--format', 'json']);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.output)).toEqual({ files: [] });
    expect(json.errors).toContain('Skipped: story format is SugarCube');

    const sarif = await check(['--format', 'sarif']);
    expect(sarif.exitCode).toBe(0);
    const parsed = JSON.parse(sarif.output);
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.runs[0].results).toEqual([]);
  });

  it('finds the StoryData of the project when checking a single passage file', async () => {
    project('Harlowe');
    const { exitCode, output, errors } = await check(
      ['--format', 'json', 'Act1.twee'],
      join(dir, 'src/story'),
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toEqual({ files: [] });
    expect(errors).toContain('Skipped: story format is Harlowe, not Spindle');
  });

  it('checks a Spindle story as before', async () => {
    project(' Spindle ');
    const { exitCode, output, errors } = await check(['--format', 'json']);
    expect(exitCode).toBe(1);
    const codes = JSON.parse(output).files.flatMap(
      (f: { diagnostics: Array<{ code: string }> }) => f.diagnostics.map(d => d.code),
    );
    expect(codes).toContain('SP102');
    expect(codes).toContain('SP100');
    expect(errors).toBe('');
  });

  it('checks a story whose StoryData does not parse as before', async () => {
    project('SugarCube"');
    const { exitCode, errors } = await check(['--format', 'json']);
    expect(exitCode).toBe(1);
    expect(errors).toBe('');
  });
});

describe('CLI check: missing StoryVariables (#78)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function project(files: Record<string, string>): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'spindle-lsp-sp202-')));
    dirs.push(root);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
    return root;
  }

  it('D78: an explicit Spindle story without StoryVariables exits 1', async () => {
    const root = project({ 'story.tw': ':: StoryData\n{"format":"Spindle"}\n:: Start\nhello\n' });
    const { exitCode, output } = await captureStdout(() => runCheck([join(root, 'story.tw')]));
    expect(exitCode).toBe(1);
    expect(output).toContain('SP202');
  });

  it('C-D78: an empty StoryVariables passage exits 0', async () => {
    const root = project({ 'story.tw': ':: StoryData\n{"format":"Spindle"}\n:: StoryVariables\n:: Start\nhello\n' });
    const { exitCode } = await captureStdout(() => runCheck([join(root, 'story.tw')]));
    expect(exitCode).toBe(0);
  });

  it('C-M-SP202: a declared Spindle story in an explicitly named non-.tw file exits 1 with SP202', async () => {
    const root = project({ 'story.tw2': ':: StoryData\n{"format":"Spindle"}\n:: Start\nhello\n' });
    const { exitCode, output } = await captureStdout(() => runCheck([join(root, 'story.tw2')]));
    expect(exitCode).toBe(1);
    expect(output).toContain('SP202');
  });

  it('C-M-SP202-empty: only an empty story file or a passage-less non-story file exits 0 without SP202', async () => {
    const root = project({ 'empty.tw': '', 'readme.md': '# Notes\n' });
    for (const files of [[join(root, 'empty.tw')], [join(root, 'readme.md')], [join(root, 'empty.tw'), join(root, 'readme.md')]]) {
      const { exitCode, output } = await captureStdout(() => runCheck(files));
      expect(exitCode).toBe(0);
      expect(output).not.toContain('SP202');
    }
  });
});
