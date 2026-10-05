import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  findMacroSourceFiles,
  findProjectRoot,
  isExcludedMacroSource,
} from '../../src/core/workspace/macro-sources.js';

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

describe('isExcludedMacroSource', () => {
  const root = '/home/me/game';

  it.each([
    'node_modules/lib/index.js',
    'dist/app.bundle.js',
    'build/app.js',
    'src/node_modules/lib/index.ts',
    '.git/hooks/pre-commit.js',
    '.storybook/preview.js',
    '.config/macros.ts',
    'src/.cache/m.mjs',
    '.eslintrc.js',
  ])('excludes %s', path => {
    expect(isExcludedMacroSource(`${root}/${path}`, root)).toBe(true);
  });

  it.each([
    'macros.js',
    'src/scripts/macros.ts',
    'distribution/m.js',
    'src/my.config.js',
  ])('keeps %s', path => {
    expect(isExcludedMacroSource(`${root}/${path}`, root)).toBe(false);
  });

  it('only considers the path below the root', () => {
    expect(isExcludedMacroSource('/home/me/.projects/game/macros.js', '/home/me/.projects/game')).toBe(false);
    expect(isExcludedMacroSource('/home/me/dist/game/macros.js', '/home/me/dist/game')).toBe(false);
  });

  it('does not treat a path outside the root as hidden', () => {
    expect(isExcludedMacroSource('/home/me/other/macros.js', root)).toBe(false);
  });
});

describe('findMacroSourceFiles', () => {
  const tree = [
    'macros.js',
    'src/scripts/macros.ts',
    'src/lib/util.mjs',
    'src/lib/util.cts',
    'story/a.tw',
    'node_modules/lib/index.js',
    'src/node_modules/lib/index.js',
    'dist/app.bundle.js',
    'build/app.js',
    '.git/hooks/pre-commit.js',
    '.storybook/preview.js',
    '.config/macros.ts',
    'src/.cache/m.mjs',
    '.eslintrc.js',
  ];

  it('finds exactly the JS/TS files the exclusion predicate keeps', async () => {
    for (const path of tree) touch(path);
    const found = (await findMacroSourceFiles(dir)).sort();
    const expected = tree
      .map(path => join(dir, path))
      .filter(path => /\.[cm]?[jt]s$/.test(path) && !isExcludedMacroSource(path, dir))
      .sort();
    expect(found).toEqual(expected);
    expect(found.map(path => path.slice(dir.length + 1)).sort()).toEqual([
      'macros.js',
      'src/lib/util.cts',
      'src/lib/util.mjs',
      'src/scripts/macros.ts',
    ]);
  });

  it('searches a root that is itself inside a dot-folder', async () => {
    touch('.projects/game/macros.js');
    touch('.projects/game/.storybook/preview.js');
    expect(await findMacroSourceFiles(join(dir, '.projects/game'))).toEqual([
      join(dir, '.projects/game/macros.js'),
    ]);
  });
});
