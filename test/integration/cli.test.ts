import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
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
});
