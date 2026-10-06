import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseStoryVariables } from '../../node_modules/@rohal12/spindle/src/story-variables.js';
import { prepareRename, computeRename, RenameError, type RenameEdit } from '../../src/plugins/rename.js';

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

  it('returns the whole escaped name of a passage header', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: A\\[B\\] [tag]\nContent here',
    });
    const result = prepareRename('file:///test.tw', { line: 0, character: 7 }, ws);
    expect(result).toEqual({
      range: { start: { line: 0, character: 3 }, end: { line: 0, character: 9 } },
      placeholder: 'A[B]',
    });
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

  it('renames a passage whose name has escaped brackets, escaping the new header name', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: A\\[B\\] [tag]\ntext\n\n:: Start\n{goto "A[B]"}',
    });
    const result = applyRename(ws, 'file:///test.tw', { line: 0, character: 5 }, 'C{D}');
    expect(result.get('file:///test.tw')).toBe(':: C\\{D\\} [tag]\ntext\n\n:: Start\n{goto "C{D}"}');
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

describe('computeRename: executable references in StoryInit and strings (#44)', () => {
  it('renames StoryInit assignments, quoted receivers and interpolations', () => {
    const content = [
      ':: StoryVariables',
      '$x = 1',
      ':: StoryInit',
      '{set $x = 2}',
      ':: Start',
      '{textbox "$x"}',
      '{print `${$x}`}',
      '{button "{$x}"}go{/button}',
    ].join('\n');
    const ws = createWorkspace({ name: 'test.tw', content });
    const result = applyRename(ws, 'file:///test.tw', { line: 1, character: 1 }, 'y');
    expect(result.get('file:///test.tw')).toBe([
      ':: StoryVariables',
      '$y = 1',
      ':: StoryInit',
      '{set $y = 2}',
      ':: Start',
      '{textbox "$y"}',
      '{print `${$y}`}',
      '{button "{$y}"}go{/button}',
    ].join('\n'));
  });

  it('renames transients in StoryInit and string interpolations', () => {
    const content = [
      ':: StoryTransients',
      '%t = 1',
      ':: StoryInit',
      '{set %t = 2}',
      ':: Start',
      '{print `n: ${%t}`} {button "{%t}"}go{/button}',
    ].join('\n');
    const ws = createWorkspace({ name: 'test.tw', content });
    const result = applyRename(ws, 'file:///test.tw', { line: 1, character: 1 }, 'u');
    expect(result.get('file:///test.tw')).toBe([
      ':: StoryTransients',
      '%u = 1',
      ':: StoryInit',
      '{set %u = 2}',
      ':: Start',
      '{print `n: ${%u}`} {button "{%u}"}go{/button}',
    ].join('\n'));
  });

  it('renames quoted receivers of custom storeVar macros', () => {
    const files = {
      'macros.tw': ':: Macros [script]\nStory.defineMacro({name: "Picker", storeVar: true, render: () => null});',
      'test.tw': ':: StoryVariables\n$x = 1\n:: Start\n{picker "$x"} {other "$x"}',
    };
    const ws = createWorkspace(
      ...Object.entries(files).map(([name, content]) => ({ name, content })),
    );
    expect(applyRenameToFiles(files, computeRename('file:///test.tw', { line: 1, character: 1 }, 'y', ws)))
      .toEqual({ ...files, 'test.tw': ':: StoryVariables\n$y = 1\n:: Start\n{picker "$y"} {other "$x"}' });
  });

  it('leaves literal string text alone', () => {
    const content = [
      ':: StoryVariables',
      '$x = 1',
      ':: Start',
      '{print "costs $x"} {print \'$x\'} {print `$x and ${"$x"}`}',
      '{set $x = 2} {link "Pay $x"}go{/link} {print "{x}"}',
      '{print "$x" + $x}',
    ].join('\n');
    const ws = createWorkspace({ name: 'test.tw', content });
    const result = applyRename(ws, 'file:///test.tw', { line: 1, character: 1 }, 'y');
    expect(result.get('file:///test.tw')).toBe([
      ':: StoryVariables',
      '$y = 1',
      ':: Start',
      '{print "costs $x"} {print \'$x\'} {print `$x and ${"$x"}`}',
      '{set $y = 2} {link "Pay $x"}go{/link} {print "{x}"}',
      '{print "$x" + $y}',
    ].join('\n'));
  });

  it('renames references between apostrophes and quotes in prose', () => {
    const content = [
      ':: StoryVariables',
      '$x = 1',
      ':: Start',
      "Don't do it.",
      '{set $x = 2}',
      "It's fine {$x}",
      '"I {if $x > 1}hate{else}like{/if} you," she said.',
    ].join('\n');
    const ws = createWorkspace({ name: 'test.tw', content });
    const result = applyRename(ws, 'file:///test.tw', { line: 1, character: 1 }, 'y');
    expect(result.get('file:///test.tw')).toBe([
      ':: StoryVariables',
      '$y = 1',
      ':: Start',
      "Don't do it.",
      '{set $y = 2}',
      "It's fine {$y}",
      '"I {if $y > 1}hate{else}like{/if} you," she said.',
    ].join('\n'));
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

describe('N-rename: invalid new names fail the whole request and name the offender', () => {
  const uri = 'file:///story.tw';
  const other = 'file:///other.tw';
  const make = () =>
    createWorkspace(
      { name: 'story.tw', content: ':: StoryVariables\n$hp = 1\n:: Old\nhello\n:: Start\n{goto "Old"}\n[[x|Old]] {$hp}' },
      { name: 'other.tw', content: ':: Other\nbefore [[Old]] after {link "go" "Old"}{/link}' },
    );
  const at = { line: 2, character: 4 };

  function failure(run: () => unknown): RenameError {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(RenameError);
      return error as RenameError;
    }
    throw new Error('expected a RenameError');
  }

  it('N-rename-offender: the message and fields locate the reference that cannot hold the name', () => {
    const ws = make();
    // `a|b` fits {goto "..."} but not [[...]]; the first bracket link is on story.tw line 7
    const error = failure(() => computeRename(uri, at, 'a|b', ws));
    expect(error.uri).toBe(uri);
    expect(error.range!.start).toEqual({ line: 6, character: 4 });
    expect(error.message).toContain('[[link]]');
    expect(error.message).toContain(`${uri}:7:5`);
  });

  it('N-rename-offender-other-file: an offender in another file is named by that file', () => {
    const ws = createWorkspace(
      { name: 'story.tw', content: ':: StoryVariables\n:: Old\nhello\n:: Start\n{goto "Old"}' },
      { name: 'other.tw', content: ':: Other\nbefore {link "go" "Old"}{/link}' },
    );
    const error = failure(() => computeRename(uri, { line: 1, character: 4 }, 'Bob"s', ws));
    expect(error.uri).toBe(other);
    expect(error.message).toContain('{link}');
    expect(error.message).toContain(`${other}:2:20`);
  });

  it('N-rename-atomic: a failing rename returns no partial edits for any document', () => {
    const ws = make();
    expect(() => computeRename(uri, at, 'a|b', ws)).toThrow(RenameError);
    // and the same request with a name every context can hold produces edits for both files
    const ok = computeRename(uri, at, 'New', ws);
    expect([...ok.keys()].sort()).toEqual([other, uri]);
  });

  it('N-rename-header: a passage name its own header cannot hold is rejected', () => {
    const ws = createWorkspace({ name: 'story.tw', content: ':: StoryVariables\n:: Old\nhello\n:: Start\n{goto "Old"}' });
    for (const name of ['', '   ', 'two\nlines', 'cr\rhere', ' lead', 'trail ']) {
      const error = failure(() => computeRename(uri, { line: 1, character: 4 }, name, ws));
      expect(error.uri, JSON.stringify(name)).toBe(uri);
      expect(error.range!.start).toEqual({ line: 1, character: 3 });
    }
    // Twee metacharacters are escaped, not rejected
    const output = applyRename(ws, uri, { line: 1, character: 4 }, 'A[B]');
    expect(output.get(uri)).toContain(':: A\\[B\\]');
  });

  it('N-rename-variable: a new variable name is sigil + word characters; sigils are accepted', () => {
    const ws = make();
    const cursor = { line: 1, character: 2 };
    for (const name of ['', 'a b', 'a-b', 'a.b', '$', '%', 'x"y', 'a$b', '$a$b', '$$x', '%x%y']) {
      const error = failure(() => computeRename(uri, cursor, name, ws));
      expect(error.message, name).toContain('word characters');
      expect(error.uri).toBe(uri);
    }
    expect(applyRename(ws, uri, cursor, '$mana').get(uri)).toContain('$mana = 1');
    expect(applyRename(ws, uri, cursor, 'mana').get(uri)).toContain('{$mana}');
  });

  it('#83: digit-leading and underscore names are valid; an internal $ is rejected atomically', () => {
    for (const [sigil, passage, parse] of [
      ['$', 'StoryVariables', (t: string) => parseStoryVariables(t, '$')],
      ['%', 'StoryTransients', (t: string) => parseStoryVariables(t, '%')],
    ] as const) {
      const files = [
        { name: 'decl.tw', content: `:: ${passage}\n${sigil}x = {p: 1}` },
        { name: 'use.tw', content: `:: Start\n{${sigil}x.p} {set ${sigil}x = {p: 2}}` },
      ];
      const ws = createWorkspace(...files);
      const cursor = { line: 1, character: 1 };
      for (const name of ['5', '_', '_x', '007', 'a_1', `${sigil}5`]) {
        const bare = name.replace(/^[$%]/, '');
        const out = applyRename(ws, 'file:///decl.tw', cursor, name);
        const decl = out.get('file:///decl.tw')!;
        expect(decl, name).toBe(`:: ${passage}\n${sigil}${bare} = {p: 1}`);
        expect(out.get('file:///use.tw'), name).toBe(`:: Start\n{${sigil}${bare}.p} {set ${sigil}${bare} = {p: 2}}`);
        // the runtime reads the rebuilt declaration as the new key
        expect([...parse(decl.split('\n')[1]!).keys()], name).toEqual([bare]);
      }
      for (const name of ['a$b', `${sigil}a$b`, '$', '5$', 'a.b']) {
        expect(() => computeRename('file:///decl.tw', cursor, name, ws), name).toThrow(RenameError);
      }
      // a rejected rename is atomic: the workspace text is untouched
      expect(ws.documents.getText('file:///decl.tw')).toBe(files[0]!.content);
    }
  });

  it('N-rename-widget: a new widget name must be callable and must not shadow a macro', () => {
    const ws = createWorkspace(
      { name: 'w.tw', content: ':: Widgets [widget]\n{widget "greet" @x}\n{@x}\n{/widget}' },
      { name: 'story.tw', content: ':: Start\n{greet 1}' },
    );
    const cursor = { line: 1, character: 11 };
    for (const name of ['', 'a b', '_w', '1w', 'w!', '$w']) {
      expect(() => computeRename('file:///w.tw', cursor, name, ws), name).toThrow(RenameError);
    }
    expect(() => computeRename('file:///w.tw', cursor, 'if', ws)).toThrow(/macro of that name/);
    const output = applyRename(ws, 'file:///w.tw', cursor, 'hello-2');
    expect(output.get(uri)).toBe(':: Start\n{hello-2 1}');
    expect(output.get('file:///w.tw')).toContain('{widget "hello-2" @x}');
  });

  it('N-rename-consistent: whatever prepareRename accepts, renaming to its placeholder succeeds', () => {
    const ws = make();
    for (const [file, position] of [
      [uri, { line: 2, character: 4 }],
      [uri, { line: 5, character: 10 }],
      [uri, { line: 1, character: 2 }],
      [uri, { line: 6, character: 14 }],
      [other, { line: 1, character: 12 }],
    ] as const) {
      const prepared = prepareRename(file, position, ws);
      expect(prepared, `${file}:${position.line}:${position.character}`).not.toBeNull();
      expect(() => computeRename(file, position, prepared!.placeholder, ws)).not.toThrow();
    }
  });

  it('N-rename-lsp: the request fails with InvalidParams and the located message, not an edit', async () => {
    const { renamePlugin } = await import('../../src/plugins/rename.js');
    const { ErrorCodes, ResponseError } = await import('vscode-languageserver');
    let handler: ((p: unknown) => any) | undefined;
    const ws = make();
    renamePlugin.initialize!({
      connection: { onPrepareRename: () => {}, onRenameRequest: (h: any) => { handler = h; } },
      workspace: ws,
    } as any);
    const result = handler!({ textDocument: { uri }, position: at, newName: 'a|b' });
    expect(result).toBeInstanceOf(ResponseError);
    expect(result.code).toBe(ErrorCodes.InvalidParams);
    expect(result.message).toContain(`${uri}:7:5`);
    const ok = handler!({ textDocument: { uri }, position: at, newName: 'New' });
    expect(Object.keys(ok.changes).sort()).toEqual([other, uri]);
  });
});
