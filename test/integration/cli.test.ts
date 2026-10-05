import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
      expect(sp100For(output)).toEqual(['Unrecognized macro: {other}']);
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
