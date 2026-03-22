import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { prepareRename, computeRename } from '../../src/plugins/rename.js';

function createWorkspace(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const ws = new WorkspaceModel();
  const contents = new Map<string, string>();
  for (const f of files) {
    contents.set(`file:///${f.name}`, f.content);
  }
  ws.initialize(contents);
  return ws;
}

describe('prepareRename', () => {
  it('returns range and placeholder for passage header', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: MyPassage\nContent here',
    });
    const result = prepareRename('file:///test.tw', { line: 0, character: 5 }, ws);
    expect(result).not.toBeNull();
    expect(result!.placeholder).toBe('MyPassage');
  });

  it('returns range and placeholder for $variable', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{set $health = 100}',
    });
    const result = prepareRename('file:///test.tw', { line: 1, character: 6 }, ws);
    expect(result).not.toBeNull();
    expect(result!.placeholder).toBe('health');
  });

  it('returns null for plain text', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\nPlain text',
    });
    const result = prepareRename('file:///test.tw', { line: 1, character: 3 }, ws);
    expect(result).toBeNull();
  });

  it('returns range and placeholder for widget name', () => {
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
    // Cursor on "greeting" in the invocation
    const result = prepareRename('file:///test.tw', { line: 1, character: 2 }, ws);
    expect(result).not.toBeNull();
    expect(result!.placeholder).toBe('greeting');
  });
});

describe('computeRename', () => {
  it('renames passage header and all link references', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n[[Next]]\n\n:: Next\nContent',
    });
    const edits = computeRename(
      'file:///test.tw', { line: 3, character: 4 }, 'Renamed', ws,
    );
    expect(edits.size).toBeGreaterThan(0);
    const allEdits = Array.from(edits.values()).flat();
    // Should have at least the header declaration + the link reference
    expect(allEdits.length).toBeGreaterThanOrEqual(2);
    expect(allEdits.every(e => e.newText === 'Renamed')).toBe(true);
  });

  it('renames variable across documents', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$health = 100\n\n:: Start\n{set $health = 50}',
    });
    const edits = computeRename(
      'file:///test.tw', { line: 4, character: 6 }, '$hp', ws,
    );
    const allEdits = Array.from(edits.values()).flat();
    // Should rename at least the usage
    expect(allEdits.length).toBeGreaterThanOrEqual(1);
    // Variable rename strips the $ prefix
    expect(allEdits.some(e => e.newText === 'hp')).toBe(true);
  });

  it('renames widget definition and invocations', () => {
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
    const edits = computeRename(
      'file:///test.tw', { line: 1, character: 2 }, 'hello', ws,
    );
    const allEdits = Array.from(edits.values()).flat();
    // Should rename invocation in test.tw + definition in widgets.tw
    expect(allEdits.length).toBeGreaterThanOrEqual(2);
    expect(allEdits.every(e => e.newText === 'hello')).toBe(true);
  });
});
