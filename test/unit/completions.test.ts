import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { getCompletions } from '../../src/plugins/completions.js';

function createWorkspace(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const ws = new WorkspaceModel();
  const contents = new Map<string, string>();
  for (const f of files) {
    contents.set(`file:///${f.name}`, f.content);
  }
  ws.initialize(contents);
  return ws;
}

describe('getCompletions', () => {
  it('returns macro names after opening brace', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{',
    });
    const items = getCompletions('file:///test.tw', { line: 1, character: 1 }, '{', ws);
    // Should include at least some macros from the registry
    const macroNames = items.map(i => i.label);
    // The workspace loads builtins + supplements, so there should be macros
    expect(items.length).toBeGreaterThan(0);
    // All items should be function kind
    expect(items.every(i => i.kind === 3)).toBe(true);
  });

  it('returns story variable completions after $', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$health = 100\n$name = "Hero"\n\n:: Start\n{set $',
    });
    const items = getCompletions('file:///test.tw', { line: 5, character: 6 }, '$', ws);
    const labels = items.map(i => i.label);
    expect(labels).toContain('$health');
    expect(labels).toContain('$name');
    expect(items.every(i => i.kind === 6)).toBe(true);
  });

  it('returns passage name completions after [[', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n[[\n\n:: NextPassage\nHello',
    });
    const items = getCompletions('file:///test.tw', { line: 1, character: 2 }, '[', ws);
    const labels = items.map(i => i.label);
    expect(labels).toContain('Start');
    expect(labels).toContain('NextPassage');
  });

  it('returns temp variable completions after _', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{set _tempVar = 1}\n{set _',
    });
    const items = getCompletions('file:///test.tw', { line: 2, character: 6 }, '_', ws);
    const labels = items.map(i => i.label);
    expect(labels).toContain('_tempVar');
  });

  it('returns local variable completions after @', () => {
    const ws = createWorkspace({
      name: 'widgets.tw',
      content: ':: MyWidget [widget]\n{widget "test" @param1 @param2}\n{@',
    });
    const items = getCompletions('file:///widgets.tw', { line: 2, character: 2 }, '@', ws);
    const labels = items.map(i => i.label);
    expect(labels).toContain('@param1');
    expect(labels).toContain('@param2');
  });

  it('returns dot-path field completions after $var.', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$player = { health: 100, mana: 50 }\n\n:: Start\n{set $player.',
    });
    const items = getCompletions('file:///test.tw', { line: 4, character: 13 }, '.', ws);
    const labels = items.map(i => i.label);
    expect(labels).toContain('health');
    expect(labels).toContain('mana');
  });

  it('returns widget names in macro completions', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: MyWidgets [widget]\n{widget "greeting" @name}\nHello, {@name}!\n{/widget}',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{',
      },
    );
    const items = getCompletions('file:///test.tw', { line: 1, character: 1 }, '{', ws);
    const labels = items.map(i => i.label);
    expect(labels).toContain('greeting');
  });

  it('returns closing macro names after {/', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{if $x}\nsome text\n{/',
    });
    const items = getCompletions('file:///test.tw', { line: 3, character: 2 }, '/', ws);
    const labels = items.map(i => i.label);
    expect(labels).toContain('{/if}');
  });

  it('returns transient variable completions after %', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryTransients\n%npcList = []\n%agents = {}\n\n:: Start\n{set %',
    });
    const items = getCompletions('file:///test.tw', { line: 5, character: 6 }, '%', ws);
    const labels = items.map(i => i.label);
    expect(labels).toContain('%npcList');
    expect(labels).toContain('%agents');
    expect(items.every(i => i.kind === 6)).toBe(true);
  });

  it('returns dot-path completions for %var.', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryTransients\n%player = { health: 100, name: "Hero" }\n\n:: Start\n{%player.',
    });
    const items = getCompletions('file:///test.tw', { line: 4, character: 9 }, '.', ws);
    const labels = items.map(i => i.label);
    expect(labels).toContain('health');
    expect(labels).toContain('name');
  });

  it('returns empty array when no context matches', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\nplain text here',
    });
    const items = getCompletions('file:///test.tw', { line: 1, character: 5 }, undefined, ws);
    expect(items).toHaveLength(0);
  });
});
