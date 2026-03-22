import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import {
  findReferences,
  findPassageReferences,
  findVariableReferences,
  findWidgetReferences,
} from '../../src/plugins/references.js';

function createWorkspace(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const ws = new WorkspaceModel();
  const contents = new Map<string, string>();
  for (const f of files) {
    contents.set(`file:///${f.name}`, f.content);
  }
  ws.initialize(contents);
  return ws;
}

describe('findPassageReferences', () => {
  it('finds [[link]] references to a passage', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n[[Next]]\n[[Display|Next]]\n\n:: Next\nHello',
    });
    const refs = findPassageReferences('Next', ws, false);
    // Should find 2 link references (not the declaration)
    expect(refs.length).toBe(2);
  });

  it('includes declaration when requested', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n[[Next]]\n\n:: Next\nHello',
    });
    const refs = findPassageReferences('Next', ws, true);
    // 1 declaration + 1 link reference
    expect(refs.length).toBe(2);
  });

  it('finds macro passage references (goto, include)', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{goto "Target"}\n{include "Target"}\n\n:: Target\nContent',
    });
    const refs = findPassageReferences('Target', ws, false);
    expect(refs.length).toBe(2);
  });
});

describe('findVariableReferences', () => {
  it('finds variable usages across workspace', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$health = 100\n\n:: Start\n{set $health = 50}\n{if $health > 10}ok{/if}',
    });
    const refs = findVariableReferences('health', ws, false);
    // Should find usages in Start passage
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('findWidgetReferences', () => {
  it('finds widget invocations', () => {
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
    const refs = findWidgetReferences('greeting', ws, false);
    // Should find 2 invocations in test.tw
    expect(refs.length).toBe(2);
  });

  it('includes declaration when requested', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: MyWidgets [widget]\n{widget "greeting" @name}\nHello {@name}!\n{/widget}',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{greeting "World"}',
      },
    );
    const refs = findWidgetReferences('greeting', ws, true);
    // 1 definition + 1 invocation
    expect(refs.length).toBe(2);
  });
});

describe('findReferences (top-level)', () => {
  it('finds passage references when cursor is on passage header', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n[[Next]]\n\n:: Next\nEnd.',
    });
    // Cursor on "Next" in the ":: Next" header
    const refs = findReferences('file:///test.tw', { line: 3, character: 4 }, ws, true);
    expect(refs.length).toBeGreaterThan(0);
  });
});
