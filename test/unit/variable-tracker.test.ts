import { describe, it, expect } from 'vitest';
import { VariableTracker } from '../../src/core/workspace/variable-tracker.js';
import type { MacroNode } from '../../src/core/types.js';

describe('VariableTracker', () => {
  it('parses StoryVariables declarations', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$name = "player"\n$health = 100\n$score = 0`);
    expect(tracker.hasStoryVariables()).toBe(true);
    const declared = tracker.getDeclared();
    expect(declared.size).toBe(3);
    expect(declared.has('name')).toBe(true);
    expect(declared.has('health')).toBe(true);
    expect(declared.has('score')).toBe(true);
  });

  it('parses object fields from StoryVariables', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$player = { name: "hero", hp: 100, inventory: [] }`);
    const declared = tracker.getDeclared();
    expect(declared.has('player')).toBe(true);
    const player = declared.get('player')!;
    expect(player.fields).toContain('name');
    expect(player.fields).toContain('hp');
    expect(player.fields).toContain('inventory');
  });

  it('skips comments and blank lines', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`// this is a comment\n\n$name = "test"\n<!-- html comment -->`);
    const declared = tracker.getDeclared();
    expect(declared.size).toBe(1);
    expect(declared.has('name')).toBe(true);
  });

  it('scans document for variable usages', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$name = "player"`);

    const macros: MacroNode[] = [];
    const text = `:: TestPassage\nHello {$name}, your score is {$score}.`;
    tracker.scanDocument('file:///story.tw', text, macros);

    const nameUsages = tracker.getUsages('name');
    expect(nameUsages.length).toBe(1);
    expect(nameUsages[0].uri).toBe('file:///story.tw');

    const scoreUsages = tracker.getUsages('score');
    expect(scoreUsages.length).toBe(1);
  });

  it('detects undeclared variables', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$name = "player"`);

    const text = `:: TestPassage\n{set $name to "bob"}\n{set $undeclared to 5}`;
    tracker.scanDocument('file:///story.tw', text, []);

    const undeclared = tracker.getUndeclared('file:///story.tw');
    expect(undeclared.length).toBeGreaterThan(0);
    const names = undeclared.map(u => u.name);
    expect(names).toContain('undeclared');
    expect(names).not.toContain('name');
  });

  it('tracks dot-notation field access', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$player = { hp: 100 }`);

    const text = `:: TestPassage\nHP: {$player.hp} / {$player.maxHp}`;
    tracker.scanDocument('file:///story.tw', text, []);

    const usages = tracker.getUsages('player');
    expect(usages.length).toBe(2);
  });

  it('hasStoryVariables returns false when none parsed', () => {
    const tracker = new VariableTracker();
    expect(tracker.hasStoryVariables()).toBe(false);
  });

  it('excludes special passages from scanning', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$name = "player"`);

    // StoryVariables, StoryInit content should not generate usages
    const text = `:: StoryVariables\n$name = "player"\n$count = 0`;
    tracker.scanDocument('file:///story.tw', text, []);

    // Usages within StoryVariables itself should be excluded
    const usages = tracker.getUsages('name');
    expect(usages.length).toBe(0);
  });

  it('replaces usages when re-scanning the same document', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$name = "player"`);

    tracker.scanDocument('file:///a.tw', ':: Test\n{$name}', []);
    expect(tracker.getUsages('name').length).toBe(1);

    tracker.scanDocument('file:///a.tw', ':: Test\n{$name} and {$name}', []);
    expect(tracker.getUsages('name').length).toBe(2);
  });
});
