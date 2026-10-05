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

  it('renames widgets defined with single-quoted and bare names', () => {
    const files = {
      'widgets.tw': ":: W [widget]\n{widget 'hello' @name}Hi{/widget}\n{widget bye $who}Bye{/widget}",
      'test.tw': ':: Start\n{hello "Sam"} {bye "Sam"}',
    };
    const ws = createWorkspace(
      ...Object.entries(files).map(([name, content]) => ({ name, content })),
    );

    let out = applyRenameToFiles(files, computeRename('file:///test.tw', { line: 1, character: 2 }, 'greet', ws));
    expect(out['widgets.tw']).toBe(":: W [widget]\n{widget 'greet' @name}Hi{/widget}\n{widget bye $who}Bye{/widget}");
    expect(out['test.tw']).toBe(':: Start\n{greet "Sam"} {bye "Sam"}');

    // Starting from the bare-name definition itself
    out = applyRenameToFiles(files, computeRename('file:///widgets.tw', { line: 2, character: 9 }, 'farewell', ws));
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
      expect(applyRenameToFiles(files, computeRename(uri, pos, 'newWrap', ws))).toEqual(expected);
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
    expect(applyRenameToFiles(files, computeRename('file:///test.tw', { line: 1, character: 2 }, 'Greet', ws)))
      .toEqual(expected);
    expect(applyRenameToFiles(files, computeRename('file:///widgets.tw', { line: 1, character: 10 }, 'Greet', ws)))
      .toEqual(expected);
  });
});

describe('rename from a passage reference', () => {
  const content = [
    ':: Start',
    '[[Next]] [[Go on|Next]] [[Go on->Next]] [[Next<-Go on]]',
    `{goto "Next"} {include 'Next'} {link "Go on" "Next"} {goto Next}`,
    '',
    ':: Next',
    'Hello',
  ].join('\n');
  const renamed = [
    ':: Start',
    '[[After]] [[Go on|After]] [[Go on->After]] [[After<-Go on]]',
    `{goto "After"} {include 'After'} {link "Go on" "After"} {goto After}`,
    '',
    ':: After',
    'Hello',
  ].join('\n');
  const lines = content.split('\n');

  // Every occurrence of `Next` on the reference lines is a link or macro target
  const refPositions: Array<{ line: number; character: number }> = [];
  for (const line of [1, 2]) {
    let i = -1;
    while ((i = lines[line].indexOf('Next', i + 1)) !== -1) {
      refPositions.push({ line, character: i });
    }
  }

  it('covers every link and macro form', () => {
    expect(refPositions).toHaveLength(8);
  });

  it('prepareRename returns the target range only, not the link label', () => {
    const ws = createWorkspace({ name: 'test.tw', content });
    for (const pos of refPositions) {
      for (const character of [pos.character, pos.character + 2, pos.character + 4]) {
        const result = prepareRename('file:///test.tw', { line: pos.line, character }, ws);
        expect(result, `line ${pos.line} char ${character}`).toEqual({
          placeholder: 'Next',
          range: {
            start: { line: pos.line, character: pos.character },
            end: { line: pos.line, character: pos.character + 4 },
          },
        });
      }
    }
  });

  it('prepareRename returns null on a link label', () => {
    const ws = createWorkspace({ name: 'test.tw', content });
    const label = lines[1].indexOf('Go on');
    expect(prepareRename('file:///test.tw', { line: 1, character: label + 1 }, ws)).toBeNull();
  });

  it('renames the declaration and all references from any reference', () => {
    const ws = createWorkspace({ name: 'test.tw', content });
    for (const pos of refPositions) {
      const result = applyRename(ws, 'file:///test.tw', pos, 'After');
      expect(result.get('file:///test.tw'), `line ${pos.line} char ${pos.character}`).toBe(renamed);
    }
  });

  it('renames across documents from a reference', () => {
    const files = {
      'start.tw': ':: Start\n[[Next]]',
      'next.tw': ':: Next\nHello {goto "Start"}',
    };
    const ws = createWorkspace(
      ...Object.entries(files).map(([name, content]) => ({ name, content })),
    );
    expect(applyRenameToFiles(files, computeRename('file:///start.tw', { line: 1, character: 3 }, 'After', ws)))
      .toEqual({ 'start.tw': ':: Start\n[[After]]', 'next.tw': ':: After\nHello {goto "Start"}' });
  });

  it('does not rename a reference to an unknown passage', () => {
    const ws = createWorkspace({ name: 'test.tw', content: ':: Start\n[[Missing]] {goto "Missing"}' });
    expect(prepareRename('file:///test.tw', { line: 1, character: 3 }, ws)).toBeNull();
    expect(prepareRename('file:///test.tw', { line: 1, character: 19 }, ws)).toBeNull();
    expect(computeRename('file:///test.tw', { line: 1, character: 3 }, 'Found', ws).size).toBe(0);
  });
});

function applyRenameToFiles(
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
