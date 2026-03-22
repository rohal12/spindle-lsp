import { describe, it, expect } from 'vitest';
import { PassageIndex } from '../../src/core/workspace/passage-index.js';

const sampleDoc = `:: Start
Welcome to the story!

:: Kitchen [nobr]
You enter the kitchen.

:: StoryVariables
$name = "player"
$health = 100

:: StoryInit
{set $ready to true}

:: Ending
The end.
`;

describe('PassageIndex', () => {
  it('indexes passages from a document', () => {
    const index = new PassageIndex();
    index.rebuild('file:///story.tw', sampleDoc);
    const all = index.getAllPassages();
    expect(all.length).toBe(5);
    expect(all.map(p => p.name).sort()).toEqual([
      'Ending', 'Kitchen', 'Start', 'StoryInit', 'StoryVariables',
    ]);
  });

  it('looks up a passage by name', () => {
    const index = new PassageIndex();
    index.rebuild('file:///story.tw', sampleDoc);
    const passage = index.getPassage('Kitchen');
    expect(passage).toBeDefined();
    expect(passage!.name).toBe('Kitchen');
    expect(passage!.tags).toEqual(['nobr']);
    expect(passage!.uri).toBe('file:///story.tw');
  });

  it('returns undefined for unknown passage name', () => {
    const index = new PassageIndex();
    index.rebuild('file:///story.tw', sampleDoc);
    expect(index.getPassage('NonExistent')).toBeUndefined();
  });

  it('tracks StoryVariables passage', () => {
    const index = new PassageIndex();
    index.rebuild('file:///story.tw', sampleDoc);
    const sv = index.getStoryVariables();
    expect(sv).toBeDefined();
    expect(sv!.name).toBe('StoryVariables');
  });

  it('tracks StoryInit passage', () => {
    const index = new PassageIndex();
    index.rebuild('file:///story.tw', sampleDoc);
    const si = index.getStoryInit();
    expect(si).toBeDefined();
    expect(si!.name).toBe('StoryInit');
  });

  it('gets passages in a specific document', () => {
    const index = new PassageIndex();
    index.rebuild('file:///a.tw', ':: First\nHello\n:: Second\nWorld');
    index.rebuild('file:///b.tw', ':: Third\nBye');
    expect(index.getPassagesInDocument('file:///a.tw').length).toBe(2);
    expect(index.getPassagesInDocument('file:///b.tw').length).toBe(1);
    expect(index.getPassagesInDocument('file:///c.tw').length).toBe(0);
  });

  it('gets passage at a specific line', () => {
    const index = new PassageIndex();
    index.rebuild('file:///story.tw', sampleDoc);
    // Line 0 = ":: Start", line 1 = "Welcome..."
    const passage = index.getPassageAt('file:///story.tw', 1);
    expect(passage).toBeDefined();
    expect(passage!.name).toBe('Start');
    // Line 3 = ":: Kitchen [nobr]", line 4 = "You enter..."
    const kitchen = index.getPassageAt('file:///story.tw', 4);
    expect(kitchen).toBeDefined();
    expect(kitchen!.name).toBe('Kitchen');
  });

  it('detects duplicate passage names', () => {
    const index = new PassageIndex();
    index.rebuild('file:///a.tw', ':: Duplicate\nFirst');
    index.rebuild('file:///b.tw', ':: Duplicate\nSecond\n:: Unique\nHello');
    const dupes = index.getDuplicates();
    expect(dupes.size).toBe(1);
    expect(dupes.has('Duplicate')).toBe(true);
    expect(dupes.get('Duplicate')!.length).toBe(2);
  });

  it('removes a document from the index', () => {
    const index = new PassageIndex();
    index.rebuild('file:///a.tw', ':: First\nHello');
    index.rebuild('file:///b.tw', ':: Second\nWorld');
    expect(index.getAllPassages().length).toBe(2);
    index.remove('file:///a.tw');
    expect(index.getAllPassages().length).toBe(1);
    expect(index.getPassage('First')).toBeUndefined();
    expect(index.getPassage('Second')).toBeDefined();
  });

  it('rebuild replaces previous passages for the same URI', () => {
    const index = new PassageIndex();
    index.rebuild('file:///a.tw', ':: Alpha\nHello\n:: Beta\nWorld');
    expect(index.getAllPassages().length).toBe(2);
    index.rebuild('file:///a.tw', ':: Gamma\nNew content');
    expect(index.getAllPassages().length).toBe(1);
    expect(index.getPassage('Alpha')).toBeUndefined();
    expect(index.getPassage('Gamma')).toBeDefined();
  });
});
