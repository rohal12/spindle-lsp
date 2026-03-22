import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runFormat } from '../../src/cli/format.js';

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

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'spindle-format-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('CLI format command', () => {
  it('formats files in place', async () => {
    const filePath = join(tmpDir, 'test.tw');
    writeFileSync(filePath, ':: Start\n{if $x}\n{set $y = 1}\n{/if}');

    const { exitCode } = await captureStdout(() => runFormat([filePath]));
    expect(exitCode).toBe(0);

    const result = readFileSync(filePath, 'utf-8');
    expect(result).toContain('  {set $y = 1}');
    expect(result.endsWith('\n')).toBe(true);
  });

  it('--check mode returns 1 for unformatted files', async () => {
    const filePath = join(tmpDir, 'test.tw');
    writeFileSync(filePath, ':: Start\n{if $x}\n{set $y = 1}\n{/if}');

    const { exitCode, output } = await captureStdout(() =>
      runFormat(['--check', filePath]),
    );
    expect(exitCode).toBe(1);
    expect(output).toContain('would be reformatted');

    // Verify file was NOT modified
    const result = readFileSync(filePath, 'utf-8');
    expect(result).not.toContain('  {set $y = 1}');
  });

  it('--check mode returns 0 for already-formatted files', async () => {
    const filePath = join(tmpDir, 'test.tw');
    writeFileSync(filePath, ':: Start\n{if $x}\n  {set $y = 1}\n{/if}\n');

    const { exitCode } = await captureStdout(() =>
      runFormat(['--check', filePath]),
    );
    expect(exitCode).toBe(0);
  });

  it('returns 0 when no files match', async () => {
    const { exitCode } = await captureStdout(() =>
      runFormat(['nonexistent-pattern-*.xyz']),
    );
    expect(exitCode).toBe(0);
  });

  it('removes trailing whitespace when formatting', async () => {
    const filePath = join(tmpDir, 'test.tw');
    writeFileSync(filePath, ':: Start   \nHello world   \n');

    const { exitCode } = await captureStdout(() => runFormat([filePath]));
    expect(exitCode).toBe(0);

    const result = readFileSync(filePath, 'utf-8');
    expect(result).toBe(':: Start\nHello world\n');
  });
});
