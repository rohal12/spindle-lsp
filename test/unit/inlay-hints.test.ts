import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeInlayHints } from '../../src/plugins/inlay-hints.js';

function createWorkspace(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const ws = new WorkspaceModel();
  const contents = new Map<string, string>();
  for (const f of files) {
    contents.set(`file:///${f.name}`, f.content);
  }
  ws.initialize(contents);
  return ws;
}

describe('computeInlayHints', () => {
  it('provides parameter name hints for widget invocations', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: MyWidgets [widget]\n{widget "counter" @count @label}\n{@count} {@label}\n{/widget}',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{counter 5 "hits"}',
      },
    );
    const fullRange = {
      start: { line: 0, character: 0 },
      end: { line: 10, character: 0 },
    };
    const hints = computeInlayHints('file:///test.tw', fullRange, ws);
    const paramHints = hints.filter(h => h.kind === 'parameter');
    expect(paramHints.length).toBeGreaterThanOrEqual(1);
    // Should have @count and @label parameter hints
    const labels = paramHints.map(h => h.label);
    expect(labels).toContain('@count:');
  });

  it('provides type hints for StoryVariables', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$health = 100\n$name = "Hero"\n$active = true',
    });
    const fullRange = {
      start: { line: 0, character: 0 },
      end: { line: 10, character: 0 },
    };
    const hints = computeInlayHints('file:///test.tw', fullRange, ws);
    const typeHints = hints.filter(h => h.kind === 'type');
    expect(typeHints.length).toBe(3);

    const labels = typeHints.map(h => h.label);
    expect(labels).toContain(': number');
    expect(labels).toContain(': string');
    expect(labels).toContain(': boolean');
  });

  it('returns empty for non-StoryVariables documents', () => {
    const ws = createWorkspace(
      {
        name: 'vars.tw',
        content: ':: StoryVariables\n$health = 100',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{set $health = 50}',
      },
    );
    const fullRange = {
      start: { line: 0, character: 0 },
      end: { line: 10, character: 0 },
    };
    const hints = computeInlayHints('file:///test.tw', fullRange, ws);
    const typeHints = hints.filter(h => h.kind === 'type');
    // test.tw is not the StoryVariables file, so no type hints
    expect(typeHints).toHaveLength(0);
  });

  it('respects the requested range', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$a = 1\n$b = 2\n$c = 3',
    });
    // Only request hints for line 2
    const hints = computeInlayHints('file:///test.tw', {
      start: { line: 2, character: 0 },
      end: { line: 2, character: 100 },
    }, ws);
    const typeHints = hints.filter(h => h.kind === 'type');
    expect(typeHints).toHaveLength(1);
    expect(typeHints[0].label).toBe(': number');
  });
});
