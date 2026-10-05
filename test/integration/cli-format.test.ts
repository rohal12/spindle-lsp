import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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

  it('formats container macros beyond if/for/switch', async () => {
    const filePath = join(tmpDir, 'test.tw');
    writeFileSync(filePath, ':: Start\n{button "Go"}\n{set $x = 1}\n{/button}');

    const { exitCode } = await captureStdout(() => runFormat([filePath]));
    expect(exitCode).toBe(0);

    const result = readFileSync(filePath, 'utf-8');
    expect(result).toContain('  {set $x = 1}');
  });

  it('formats custom container macros auto-detected from closing tags', async () => {
    const filePath = join(tmpDir, 'test.tw');
    writeFileSync(filePath, ':: Start\n{Section "V"}\ncontent\n{/Section}');

    const { exitCode } = await captureStdout(() => runFormat([filePath]));
    expect(exitCode).toBe(0);

    const result = readFileSync(filePath, 'utf-8');
    expect(result).toContain('  content');
  });

  it('dedents {else} to parent level', async () => {
    const filePath = join(tmpDir, 'test.tw');
    writeFileSync(filePath, ':: Start\n{if $x}\na\n{else}\nb\n{/if}');

    const { exitCode } = await captureStdout(() => runFormat([filePath]));
    expect(exitCode).toBe(0);

    const result = readFileSync(filePath, 'utf-8');
    const lines = result.split('\n');
    expect(lines[3]).toBe('{else}');
    expect(lines[4]).toBe('  b');
  });
});

describe('CLI format on a story in another format', () => {
  const storyData = (format: string) =>
    `:: StoryData\n{\n\t"ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC",\n\t"format": "${format}"\n}\n`;
  // Spindle's formatter would indent the {if} body and add a final newline
  const act = ':: Start\n{if $x}\n<<set $y to 1>>\n{/if}';

  async function formatQuietly(args: string[]): Promise<{ exitCode: number; output: string; errors: string }> {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
    try {
      return { ...await captureStdout(() => runFormat(args)), errors: errors.join('\n') };
    } finally {
      console.error = originalError;
    }
  }

  it('leaves every file untouched when the StoryData among them names another format', async () => {
    const dataPath = join(tmpDir, 'StoryData.twee');
    const actPath = join(tmpDir, 'Act1.twee');
    writeFileSync(dataPath, storyData('SugarCube') + '   \n');
    writeFileSync(actPath, act);

    for (const args of [[dataPath, actPath], ['--check', dataPath, actPath]]) {
      const { exitCode, errors } = await formatQuietly(args);
      expect(exitCode).toBe(0);
      expect(errors).toBe('Skipped: story format is SugarCube, not Spindle');
    }
    expect(readFileSync(dataPath, 'utf-8')).toBe(storyData('SugarCube') + '   \n');
    expect(readFileSync(actPath, 'utf-8')).toBe(act);
  });

  it('finds the StoryData of the project the files belong to', async () => {
    writeFileSync(join(tmpDir, 'package.json'), '{}\n');
    mkdirSync(join(tmpDir, 'src'));
    writeFileSync(join(tmpDir, 'src', 'StoryData.twee'), storyData('Harlowe'));
    const actPath = join(tmpDir, 'src', 'Act1.twee');
    writeFileSync(actPath, act);

    const { exitCode, errors } = await formatQuietly([actPath]);
    expect(exitCode).toBe(0);
    expect(errors).toContain('story format is Harlowe');
    expect(readFileSync(actPath, 'utf-8')).toBe(act);
  });

  it('formats a Spindle story, or one whose format is unknown, as before', async () => {
    for (const data of [storyData('Spindle'), ':: StoryData\n{"format": \n', '']) {
      const dataPath = join(tmpDir, 'StoryData.twee');
      const actPath = join(tmpDir, 'Act1.twee');
      writeFileSync(dataPath, data);
      writeFileSync(actPath, act);
      const { exitCode, errors } = await formatQuietly([dataPath, actPath]);
      expect(exitCode).toBe(0);
      expect(errors).toBe('');
      expect(readFileSync(actPath, 'utf-8')).toBe(':: Start\n{if $x}\n  <<set $y to 1>>\n{/if}\n');
    }
  });
});
