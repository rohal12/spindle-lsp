import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeCodeLenses } from '../../src/plugins/code-lens.js';

function createWorkspace(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const ws = new WorkspaceModel();
  const contents = new Map<string, string>();
  for (const f of files) {
    contents.set(`file:///${f.name}`, f.content);
  }
  ws.initialize(contents);
  return ws;
}

describe('computeCodeLenses', () => {
  it('shows reference count for passage headers', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n[[Next]]\n\n:: Next\nContent\n[[Start]]',
    });
    const lenses = computeCodeLenses('file:///test.tw', ws);
    expect(lenses.length).toBeGreaterThanOrEqual(2);

    // Find the lens for "Start" passage
    const startLens = lenses.find(l => l.range.start.line === 0);
    expect(startLens).toBeDefined();
    expect(startLens!.command.title).toContain('reference');

    // Find the lens for "Next" passage
    const nextLens = lenses.find(l => l.range.start.line === 3);
    expect(nextLens).toBeDefined();
    expect(nextLens!.command.title).toContain('reference');
  });

  it('shows usage count for widget definitions', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: MyWidgets [widget]\n{widget "greeting" @name}\nHello {@name}!\n{/widget}',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{greeting "World"}\n{greeting "Earth"}',
      },
    );
    const lenses = computeCodeLenses('file:///widgets.tw', ws);
    const widgetLens = lenses.find(l =>
      l.command.title.includes('usage'),
    );
    expect(widgetLens).toBeDefined();
    expect(widgetLens!.command.title).toContain('2 usages');
  });

  it('shows usage count for StoryVariables declarations', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$health = 100\n\n:: Start\n{set $health = 50}\n{if $health > 0}ok{/if}',
    });
    const lenses = computeCodeLenses('file:///test.tw', ws);
    const varLens = lenses.find(l =>
      l.range.start.line === 1 && l.command.title.includes('usage'),
    );
    expect(varLens).toBeDefined();
  });

  it('skips StoryData passage', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryData\n{"ifid": "test"}\n\n:: Start\nContent',
    });
    const lenses = computeCodeLenses('file:///test.tw', ws);
    const storyDataLens = lenses.find(l => l.range.start.line === 0);
    expect(storyDataLens).toBeUndefined();
  });
});
