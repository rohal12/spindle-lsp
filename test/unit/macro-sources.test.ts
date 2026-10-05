import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { findProjectRoot } from '../../src/core/workspace/macro-sources.js';

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'spindle-macro-sources-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function touch(path: string, content = ''): void {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
}

describe('findProjectRoot', () => {
  it.each([
    ['a spindle config file', 'game/spindle.config.yaml'],
    ['a legacy twee-config file', 'game/t3lt.twee-config.json'],
    ['a package.json', 'game/package.json'],
    ['a .git directory', 'game/.git/HEAD'],
  ])('finds the nearest ancestor with %s', (_, marker) => {
    touch(marker);
    touch('game/story/chapter/a.tw');
    expect(findProjectRoot(join(dir, 'game/story/chapter'))).toBe(join(dir, 'game'));
  });

  it('returns the start directory itself when it is the root', () => {
    touch('game/package.json');
    expect(findProjectRoot(join(dir, 'game'))).toBe(join(dir, 'game'));
  });

  it('prefers the nearest marker', () => {
    touch('package.json');
    touch('game/spindle.config.yaml');
    mkdirSync(join(dir, 'game/story'));
    expect(findProjectRoot(join(dir, 'game/story'))).toBe(join(dir, 'game'));
  });

  it('falls back to the start directory without any marker', () => {
    mkdirSync(join(dir, 'game/story'), { recursive: true });
    expect(findProjectRoot(join(dir, 'game/story'))).toBe(join(dir, 'game/story'));
  });
});
