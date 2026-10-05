import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { prepareRename, computeRename, type RenameEdit } from '../../src/plugins/rename.js';

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

  it('renames widgets defined with single-quoted and bare names', () => {
    const files = {
      'widgets.tw': ":: W [widget]\n{widget 'hello' @name}Hi{/widget}\n{widget bye $who}Bye{/widget}",
      'test.tw': ':: Start\n{hello "Sam"} {bye "Sam"}',
    };
    const ws = createWorkspace(
      ...Object.entries(files).map(([name, content]) => ({ name, content })),
    );

    let out = applyRename(files, computeRename('file:///test.tw', { line: 1, character: 2 }, 'greet', ws));
    expect(out['widgets.tw']).toBe(":: W [widget]\n{widget 'greet' @name}Hi{/widget}\n{widget bye $who}Bye{/widget}");
    expect(out['test.tw']).toBe(':: Start\n{greet "Sam"} {bye "Sam"}');

    // Starting from the bare-name definition itself
    out = applyRename(files, computeRename('file:///widgets.tw', { line: 2, character: 9 }, 'farewell', ws));
    expect(out['widgets.tw']).toBe(":: W [widget]\n{widget 'hello' @name}Hi{/widget}\n{widget farewell $who}Bye{/widget}");
    expect(out['test.tw']).toBe(':: Start\n{hello "Sam"} {farewell "Sam"}');
  });

  it('renames closing tags of block widgets, including nested ones', () => {
    const files = {
      'widgets.tw': [
        ':: Widgets [widget]',
        '{widget "wrap"}<div>{@children}</div>{/widget}',
        '{widget "outer"}{wrap}{@children}{/wrap}{/widget}',
      ].join('\n'),
      'test.tw': ':: Start\n{wrap}hello {Wrap}inner{/Wrap}{/wrap}\n{outer}x{/outer}',
    };
    const ws = createWorkspace(
      ...Object.entries(files).map(([name, content]) => ({ name, content })),
    );
    const expected = {
      'widgets.tw': [
        ':: Widgets [widget]',
        '{widget "newWrap"}<div>{@children}</div>{/widget}',
        '{widget "outer"}{newWrap}{@children}{/newWrap}{/widget}',
      ].join('\n'),
      'test.tw': ':: Start\n{newWrap}hello {newWrap}inner{/newWrap}{/newWrap}\n{outer}x{/outer}',
    };

    // From an opening tag, a closing tag and the definition
    for (const [uri, pos] of [
      ['file:///test.tw', { line: 1, character: 2 }],
      ['file:///test.tw', { line: 1, character: 32 }],
      ['file:///widgets.tw', { line: 1, character: 10 }],
    ] as const) {
      expect(applyRename(files, computeRename(uri, pos, 'newWrap', ws))).toEqual(expected);
    }
  });

  it('renames widget invocations spelled with a different case', () => {
    const files = {
      'widgets.tw': ':: W [widget]\n{widget "Hello" @name}Hi{/widget}',
      'test.tw': ':: Start\n{hello "Sam"} {HELLO "Al"}',
    };
    const ws = createWorkspace(
      ...Object.entries(files).map(([name, content]) => ({ name, content })),
    );
    const expected = {
      'widgets.tw': ':: W [widget]\n{widget "Greet" @name}Hi{/widget}',
      'test.tw': ':: Start\n{Greet "Sam"} {Greet "Al"}',
    };

    expect(prepareRename('file:///test.tw', { line: 1, character: 2 }, ws)!.placeholder).toBe('hello');
    expect(applyRename(files, computeRename('file:///test.tw', { line: 1, character: 2 }, 'Greet', ws)))
      .toEqual(expected);
    expect(applyRename(files, computeRename('file:///widgets.tw', { line: 1, character: 10 }, 'Greet', ws)))
      .toEqual(expected);
  });
});

function applyRename(
  files: Record<string, string>,
  edits: Map<string, RenameEdit[]>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    const doc = TextDocument.create(`file:///${name}`, 'twee', 1, content);
    out[name] = TextDocument.applyEdits(doc, edits.get(`file:///${name}`) ?? []);
  }
  return out;
}
