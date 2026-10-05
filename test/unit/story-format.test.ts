import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import {
  readStoryDataFormat,
  resolveStoryFormat,
  storyFormatOfTexts,
  findStoryFormat,
} from '../../src/core/workspace/story-format.js';

function storyData(format: unknown, extra = ''): string {
  return `:: StoryData\n${JSON.stringify({ ifid: 'X', format, 'format-version': '1.0' })}${extra}\n`;
}

const models: WorkspaceModel[] = [];
function workspace(files: Record<string, string>): WorkspaceModel {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map(Object.entries(files)));
  return model;
}

afterEach(() => {
  while (models.length > 0) models.pop()!.dispose();
});

describe('readStoryDataFormat', () => {
  it('reads the format field, trimmed', () => {
    expect(readStoryDataFormat('{"format": "  SugarCube "}')).toBe('SugarCube');
    expect(readStoryDataFormat('\n{\n\t"format": "spindle"\n}\n\n')).toBe('spindle');
  });

  it('accepts CRLF line endings', () => {
    expect(readStoryDataFormat('{\r\n"format": "Harlowe"\r\n}\r\n')).toBe('Harlowe');
  });

  it('returns undefined for invalid JSON, a missing or non-string field, or an empty name', () => {
    expect(readStoryDataFormat('{"format": "SugarCube",}')).toBeUndefined();
    expect(readStoryDataFormat('not json')).toBeUndefined();
    expect(readStoryDataFormat('{"ifid": "X"}')).toBeUndefined();
    expect(readStoryDataFormat('{"format": 3}')).toBeUndefined();
    expect(readStoryDataFormat('["format"]')).toBeUndefined();
    expect(readStoryDataFormat('null')).toBeUndefined();
    expect(readStoryDataFormat('{"format": "   "}')).toBeUndefined();
  });
});

describe('resolveStoryFormat', () => {
  it('matches spindle case-insensitively and with whitespace', () => {
    for (const name of ['spindle', 'Spindle', 'SPINDLE', ' spindle\t']) {
      expect(resolveStoryFormat([name]).isSpindle).toBe(true);
    }
  });

  it('is Spindle when no StoryData names a format', () => {
    expect(resolveStoryFormat([])).toEqual({ name: undefined, isSpindle: true });
    expect(resolveStoryFormat([undefined])).toEqual({ name: undefined, isSpindle: true });
  });

  it('is foreign when a StoryData names another format', () => {
    expect(resolveStoryFormat(['SugarCube'])).toEqual({ name: 'SugarCube', isSpindle: false });
    expect(resolveStoryFormat([undefined, 'Harlowe'])).toEqual({ name: 'Harlowe', isSpindle: false });
  });

  it('is Spindle if any StoryData names Spindle', () => {
    expect(resolveStoryFormat(['SugarCube', 'Spindle']).isSpindle).toBe(true);
    expect(resolveStoryFormat(['spindle', 'SugarCube']).isSpindle).toBe(true);
  });
});

describe('WorkspaceModel story format', () => {
  it('is a Spindle project without a StoryData passage', () => {
    const model = workspace({ 'file:///a.tw': ':: Start\nHello.\n' });
    expect(model.storyFormat).toBeUndefined();
    expect(model.isSpindleProject()).toBe(true);
  });

  it('reads the StoryData format', () => {
    const model = workspace({
      'file:///data.twee': storyData('SugarCube'),
      'file:///a.tw': ':: Start\nHello.\n',
    });
    expect(model.storyFormat).toBe('SugarCube');
    expect(model.isSpindleProject()).toBe(false);
  });

  it('matches spindle case-insensitively and trimmed', () => {
    const model = workspace({ 'file:///data.twee': storyData(' SPINDLE ') });
    expect(model.storyFormat).toBe('SPINDLE');
    expect(model.isSpindleProject()).toBe(true);
  });

  it('treats invalid JSON, a missing field and a non-string field as Spindle', () => {
    for (const text of [
      ':: StoryData\n{"format": "SugarCube",\n',
      ':: StoryData\n{"ifid": "X"}\n',
      ':: StoryData\n{"format": ["SugarCube"]}\n',
      ':: StoryData\n',
    ]) {
      const model = workspace({ 'file:///data.twee': text });
      expect(model.storyFormat).toBeUndefined();
      expect(model.isSpindleProject()).toBe(true);
    }
  });

  it('reads only the StoryData passage content, not the next passage', () => {
    const model = workspace({
      'file:///story.twee': storyData('SugarCube') + '\n:: Start\nHello.\n',
    });
    expect(model.storyFormat).toBe('SugarCube');
  });

  it('accepts tags or metadata on the StoryData header and CRLF line endings', () => {
    const model = workspace({
      'file:///data.twee': ':: StoryData {"position":"10,10"}\r\n{\r\n"format": "Harlowe"\r\n}\r\n',
    });
    expect(model.storyFormat).toBe('Harlowe');
    expect(model.isSpindleProject()).toBe(false);
  });

  it('is Spindle if any of several StoryData passages names Spindle', () => {
    const model = workspace({
      'file:///a.twee': storyData('SugarCube'),
      'file:///b.twee': storyData('Spindle'),
    });
    expect(model.isSpindleProject()).toBe(true);
    expect(model.storyFormat).toBe('Spindle');
  });

  it('updates live when StoryData changes, is closed or reopened', () => {
    const model = workspace({
      'file:///data.twee': storyData('SugarCube'),
      'file:///a.tw': ':: Start\nHello.\n',
    });
    const events: boolean[] = [];
    model.on('storyFormatChanged', () => events.push(model.isSpindleProject()));

    // A typo: not Spindle
    model.documents.update('file:///data.twee', storyData('spindel'));
    expect(model.isSpindleProject()).toBe(false);
    expect(model.storyFormat).toBe('spindel');

    // Fixing the typo takes effect at once
    model.documents.update('file:///data.twee', storyData('spindle'));
    expect(model.isSpindleProject()).toBe(true);

    model.documents.update('file:///data.twee', storyData('SugarCube'));
    expect(model.isSpindleProject()).toBe(false);

    // StoryData leaves the workspace: back to Spindle
    model.documents.close('file:///data.twee');
    expect(model.isSpindleProject()).toBe(true);
    expect(model.storyFormat).toBeUndefined();

    // A StoryData passage added to another document
    model.documents.update('file:///a.tw', ':: Start\nHello.\n' + storyData('Chapbook'));
    expect(model.isSpindleProject()).toBe(false);

    expect(events).toEqual([false, true, false, true, false]);
  });

  it('emits storyFormatChanged only when Spindle-ness or the format name changes', () => {
    const model = workspace({ 'file:///data.twee': storyData('SugarCube') });
    let count = 0;
    model.on('storyFormatChanged', () => count++);
    model.documents.update('file:///data.twee', storyData('SugarCube') + '\n');
    expect(count).toBe(0);
    model.documents.update('file:///data.twee', storyData('Harlowe'));
    expect(count).toBe(1);
  });
});

describe('storyFormatOfTexts', () => {
  it('reports whether any text has a StoryData passage', () => {
    expect(storyFormatOfTexts([':: Start\nHi\n'])).toEqual({
      name: undefined, isSpindle: true, hasStoryData: false,
    });
    expect(storyFormatOfTexts([':: Start\nHi\n', storyData('SugarCube')])).toEqual({
      name: 'SugarCube', isSpindle: false, hasStoryData: true,
    });
    expect(storyFormatOfTexts([':: StoryData\nnot json\n'])).toEqual({
      name: undefined, isSpindle: true, hasStoryData: true,
    });
  });
});

describe('findStoryFormat', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function project(files: Record<string, string>): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'spindle-format-detect-')));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  it('prefers a StoryData among the given files', async () => {
    const dir = project({
      'package.json': '{}',
      'src/StoryData.twee': storyData('spindle'),
    });
    const format = await findStoryFormat([storyData('SugarCube')], join(dir, 'src'));
    expect(format).toEqual({ name: 'SugarCube', isSpindle: false });
  });

  it('falls back to the StoryData of the project the files belong to', async () => {
    const dir = project({
      'package.json': '{}',
      'src/story/StoryData.twee': storyData('SugarCube'),
      'src/story/Act1.twee': ':: Start\n<<if $x>>hi<</if>>\n',
    });
    const format = await findStoryFormat([':: Start\n<<if $x>>hi<</if>>\n'], join(dir, 'src/story'));
    expect(format).toEqual({ name: 'SugarCube', isSpindle: false });
  });

  it('ignores StoryData in dependencies, build output and hidden directories', async () => {
    const dir = project({
      'package.json': '{}',
      'node_modules/lib/StoryData.twee': storyData('SugarCube'),
      'dist/StoryData.twee': storyData('SugarCube'),
      '.cache/StoryData.twee': storyData('SugarCube'),
      'src/a.twee': ':: Start\nHi\n',
    });
    const format = await findStoryFormat([':: Start\nHi\n'], join(dir, 'src'));
    expect(format).toEqual({ name: undefined, isSpindle: true });
  });

  it('is Spindle when the project has no StoryData', async () => {
    const dir = project({ 'package.json': '{}', 'a.twee': ':: Start\nHi\n' });
    expect(await findStoryFormat([':: Start\nHi\n'], dir)).toEqual({ name: undefined, isSpindle: true });
  });
});
