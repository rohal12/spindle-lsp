import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import {
  findReferences,
  findPassageReferences,
  findVariableReferences,
  findTransientReferences,
  findWidgetReferences,
} from '../../src/plugins/references.js';
import { computeRename } from '../../src/plugins/rename.js';

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

describe('findTransientReferences', () => {
  it('finds transient variable usages across workspace', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryTransients\n%npcList = []\n\n:: Start\n{set %npcList = [1]}\n{if %npcList}ok{/if}',
    });
    const refs = findTransientReferences('npcList', ws, false);
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('variable references after a document leaves the store (#45)', () => {
  const main = ':: StoryVariables\n$x = 1\n:: StoryTransients\n%y = 1\n:: Start\nHello';

  function uris(refs: Array<{ uri: string }>): string[] {
    return [...new Set(refs.map(r => r.uri))].sort();
  }

  it('drops usages of a deleted document from references and rename', () => {
    const ws = createWorkspace(
      { name: 'main.tw', content: main },
      { name: 'deleted.tw', content: ':: Deleted\n{$x} {%y}' },
    );
    expect(uris(findVariableReferences('x', ws, true))).toEqual(['file:///deleted.tw', 'file:///main.tw']);

    ws.documents.close('file:///deleted.tw');

    expect(uris(findVariableReferences('x', ws, true))).toEqual(['file:///main.tw']);
    expect(uris(findTransientReferences('y', ws, true))).toEqual(['file:///main.tw']);
    const edits = computeRename('file:///main.tw', { line: 1, character: 1 }, 'z', ws);
    expect([...edits.keys()]).toEqual(['file:///main.tw']);
  });

  it('drops usages of a document whose text was emptied', () => {
    const ws = createWorkspace(
      { name: 'main.tw', content: main },
      { name: 'other.tw', content: ':: Other\n{$x} {%y}' },
    );
    ws.documents.update('file:///other.tw', '');

    expect(uris(findVariableReferences('x', ws, true))).toEqual(['file:///main.tw']);
    expect(uris(findTransientReferences('y', ws, true))).toEqual(['file:///main.tw']);
  });
});

describe('findReferences (transient)', () => {
  it('finds transient references when cursor is on %variable', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryTransients\n%npcList = []\n\n:: Start\n{set %npcList = [1]}',
    });
    const refs = findReferences('file:///test.tw', { line: 4, character: 6 }, ws, false);
    expect(refs.length).toBeGreaterThanOrEqual(1);
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

  it('includes closing tags of block widgets only', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: W [widget]\n{widget "wrap"}<div>{@children}</div>{/widget}\n{widget "plain"}x{/widget}',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{wrap}hello{/wrap}\n{plain}{/plain}',
      },
    );
    expect(findWidgetReferences('wrap', ws, false).map(r => r.range)).toEqual([
      { start: { line: 1, character: 1 }, end: { line: 1, character: 5 } },
      { start: { line: 1, character: 13 }, end: { line: 1, character: 17 } },
    ]);
    expect(findWidgetReferences('plain', ws, false)).toHaveLength(1);
    // Starting from the closing tag
    expect(findReferences('file:///test.tw', { line: 1, character: 14 }, ws, false)).toHaveLength(2);
    // A stray closing tag of a non-block widget is not a reference
    expect(findReferences('file:///test.tw', { line: 2, character: 10 }, ws, false)).toHaveLength(0);
  });

  it('matches invocations case-insensitively', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: MyWidgets [widget]\n{widget "Greeting" @name}Hello {@name}!{/widget}',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{greeting "World"} {GREETING "Earth"}',
      },
    );
    const refs = findWidgetReferences('Greeting', ws, false);
    expect(refs.map(r => r.range)).toEqual([
      { start: { line: 1, character: 1 }, end: { line: 1, character: 9 } },
      { start: { line: 1, character: 20 }, end: { line: 1, character: 28 } },
    ]);
    // Starting from an invocation spelled differently from the definition
    expect(findReferences('file:///test.tw', { line: 1, character: 3 }, ws, false)).toHaveLength(2);
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

  it('finds references from a header whose name has escaped brackets', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: A\\[B [tag]\ntext\n\n:: Start\n{goto "A[B"}',
    });
    // Cursor on the "B" after the escaped bracket
    const refs = findReferences('file:///test.tw', { line: 0, character: 6 }, ws, true);
    expect(refs.map(r => r.range)).toEqual([
      { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } },
      { start: { line: 4, character: 7 }, end: { line: 4, character: 10 } },
    ]);
  });
});
