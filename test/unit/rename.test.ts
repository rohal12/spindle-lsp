import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
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

/** Apply a rename and return the resulting text of every edited document. */
function applyRename(
  ws: WorkspaceModel,
  uri: string,
  position: { line: number; character: number },
  newName: string,
): Map<string, string> {
  const results = new Map<string, string>();
  for (const [editUri, edits] of computeRename(uri, position, newName, ws)) {
    const doc = TextDocument.create(editUri, 'twee', 0, ws.documents.getText(editUri)!);
    results.set(editUri, TextDocument.applyEdits(doc, edits));
  }
  return results;
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

  it('returns range and placeholder for %transient variable', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryTransients\n%npcList = []\n\n:: Start\n{set %npcList = [1]}',
    });
    const result = prepareRename('file:///test.tw', { line: 4, character: 6 }, ws);
    expect(result).not.toBeNull();
    expect(result!.placeholder).toBe('npcList');
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

  it('renames transient variable across documents', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryTransients\n%npcList = []\n\n:: Start\n{set %npcList = [1]}',
    });
    const edits = computeRename(
      'file:///test.tw', { line: 4, character: 6 }, '%agents', ws,
    );
    const allEdits = Array.from(edits.values()).flat();
    expect(allEdits.length).toBeGreaterThanOrEqual(1);
    expect(allEdits.some(e => e.newText === 'agents')).toBe(true);
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

  it('keeps the $ sigil and property path of story variables', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$player = {health: 10}\n:: Start\n{$player.health}',
    });
    const result = applyRename(ws, 'file:///test.tw', { line: 3, character: 3 }, 'hero');
    expect(result.get('file:///test.tw')).toBe(
      ':: StoryVariables\n$hero = {health: 10}\n:: Start\n{$hero.health}',
    );
  });

  it('accepts a new name that includes the sigil', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$x = 0\n:: Start\n{set $x = $x + 1} {$x.toFixed}',
    });
    const result = applyRename(ws, 'file:///test.tw', { line: 3, character: 6 }, '$y');
    expect(result.get('file:///test.tw')).toBe(
      ':: StoryVariables\n$y = 0\n:: Start\n{set $y = $y + 1} {$y.toFixed}',
    );
  });

  it('keeps the % sigil and property path of transient variables', () => {
    const ws = createWorkspace(
      { name: 'transients.tw', content: ':: StoryTransients\n%npc = {name: "Bo"}' },
      { name: 'start.tw', content: ':: Start\n{%npc.name} {set %npc = {}}' },
    );
    const result = applyRename(ws, 'file:///start.tw', { line: 1, character: 2 }, 'guide');
    expect(result.get('file:///transients.tw')).toBe(':: StoryTransients\n%guide = {name: "Bo"}');
    expect(result.get('file:///start.tw')).toBe(':: Start\n{%guide.name} {set %guide = {}}');
  });

  it('renames the right text after a multi-line comment', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$x = 0\n:: Start\n<!-- comment\nmore -->\n{$x}',
    });
    const result = applyRename(ws, 'file:///test.tw', { line: 5, character: 2 }, 'y');
    expect(result.get('file:///test.tw')).toBe(
      ':: StoryVariables\n$y = 0\n:: Start\n<!-- comment\nmore -->\n{$y}',
    );
  });

  it('renames only the namespace of the symbol sigil', () => {
    const content = ':: StoryVariables\n$count = 0\n:: StoryTransients\n%count = 0\n:: Start\n{$count} {%count}';
    const ws = createWorkspace({ name: 'test.tw', content });

    const story = applyRename(ws, 'file:///test.tw', { line: 5, character: 3 }, 'total');
    expect(story.get('file:///test.tw')).toBe(
      ':: StoryVariables\n$total = 0\n:: StoryTransients\n%count = 0\n:: Start\n{$total} {%count}',
    );

    const transient = applyRename(ws, 'file:///test.tw', { line: 5, character: 12 }, 'total');
    expect(transient.get('file:///test.tw')).toBe(
      ':: StoryVariables\n$count = 0\n:: StoryTransients\n%total = 0\n:: Start\n{$count} {%total}',
    );
  });
});
