import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProjectFiles } from '../../src/core/workspace/macro-sources.js';

// Change the real filesystem between enumeration and the final path check.
const hooks = vi.hoisted(() => ({ afterGlob: undefined as (() => void) | undefined }));
vi.mock('glob', async importOriginal => {
  const actual = await importOriginal<typeof import('glob')>();
  return {
    ...actual,
    glob: async (pattern: string, options: Parameters<typeof actual.glob>[1]) => {
      const files = await actual.glob(pattern, options);
      hooks.afterGlob?.();
      return files;
    },
  };
});

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spindle-discovery-race-'));
  mkdirSync(join(directory, 'volatile'));
  writeFileSync(join(directory, 'volatile', 'removed.tw'), ':: Removed\n');
  writeFileSync(join(directory, 'retained.tw'), ':: Retained\n');
});

afterEach(() => {
  hooks.afterGlob = undefined;
  rmSync(directory, { recursive: true, force: true });
});

it.each([false, true])('retains other files when an enumerated ancestor disappears (replaced: %s)', async replace => {
  hooks.afterGlob = () => {
    rmSync(join(directory, 'volatile'), { recursive: true });
    if (replace) writeFileSync(join(directory, 'volatile'), 'now a file');
  };
  await expect(findProjectFiles(directory, '**/*.tw')).resolves.toEqual([join(directory, 'retained.tw')]);
});
