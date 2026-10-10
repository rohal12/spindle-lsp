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

  it('does not offer to close containers opened in an earlier passage', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: First\n{for @x of []}\n:: Start\n{if $x}\nsome text\n{/',
    });
    const items = getCompletions('file:///test.tw', { line: 5, character: 2 }, '/', ws);
    const labels = items.map(i => i.label);
    expect(labels).toEqual(['{/if}']);
  });

  it('offers to close an unfinished block widget invocation, but not an inline one', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Widgets [widget]\n{widget "box"}\n{@children}\n{/widget}\n{widget "greet"}\nHi\n{/widget}\n\n'
        + ':: Start\n{if $x}\n{box}\n{greet}\nsome text\n{/',
    });
    const items = getCompletions('file:///test.tw', { line: 13, character: 2 }, '/', ws);
    expect(items.map(i => i.label)).toEqual(['{/box}', '{/if}']);
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

// An HTML attribute value holds markup of its own (Spindle 0.59): `{` starts a macro there,
// `[[` is text, and a closer closes what the value itself opened.
describe('getCompletions inside HTML attribute values and labels', () => {
  const at = (content: string, line: number, character: number) =>
    getCompletions('file:///test.tw', { line, character }, undefined, createWorkspace({ name: 'test.tw', content })).map(i => i.label);

  it('offers macro names after a brace in an attribute value', () => {
    expect(at(':: Start\n<span class="{}">t</span>\n', 1, 14)).toEqual(expect.arrayContaining(['if', 'set']));
  });

  it('offers macro names after a brace in the label of a link or a button', () => {
    expect(at(':: Start\n[[Go {->Start]]', 1, 6)).toEqual(expect.arrayContaining(['if']));
    expect(at(':: Start\n{button "Go {"}x{/button}', 1, 13)).toEqual(expect.arrayContaining(['if']));
  });

  it('offers no closing tags in an attribute value', () => {
    expect(at(':: Start\n{if true}<span class="{/}">t</span>\n', 1, 24)).toEqual([]);
  });

  it('offers the closers of what the attribute value itself opened', () => {
    expect(at(':: Start\n<span class="{if true}x{/}">t</span>\n', 1, 25)).toEqual(['{/if}']);
  });

  it('offers no passage names after [[ in an attribute value: it is text there', () => {
    expect(at(':: Start\n<span class="[[">t</span>\n', 1, 15)).toEqual([]);
  });

  it('still offers variables in an attribute value', () => {
    const labels = at(':: StoryVariables\n$hp = 1\n:: Start\n<span class="{$}">t</span>\n', 3, 15);
    expect(labels).toContain('$hp');
  });
});

describe('getCompletions in half-typed and non-markup text', () => {
  const at = (content: string, line: number, character: number) =>
    getCompletions('file:///test.tw', { line, character }, undefined, createWorkspace({ name: 'test.tw', content })).map(i => i.label);

  it('offers macro names for a macro head typed inside the arguments of an unclosed macro', () => {
    expect(at(':: Start\n{set $x = {', 1, 12)).toEqual(expect.arrayContaining(['if']));
  });

  it('offers nothing after a brace in a comment, after an escaped brace or in a macro string', () => {
    expect(at(':: Start\n<!-- {i -->', 1, 7)).toEqual([]);
    expect(at(':: Start\n\\{i', 1, 3)).toEqual([]);
    expect(at(':: Start\n{print "{i"}', 1, 10)).toEqual([]);
  });

  it('offers nothing after a brace in a {do} body', () => {
    expect(at(':: Start\n{do}var o = {i{/do}', 1, 14)).toEqual([]);
  });

  it('closes the innermost block that is still open, also with a closer after the cursor', () => {
    expect(at(':: Start\n{if $x}{for @i of []}x{/', 1, 28)).toEqual(['{/for}', '{/if}']);
    expect(at(':: Start\n{if $x}{for @i of []}x{/}{/if}', 1, 28)).toEqual(['{/for}', '{/if}']);
  });

  it('closes a block through a branch of the block', () => {
    expect(at(':: Start\n{if $x}a{else}b{/', 1, 18)).toEqual(['{/if}']);
  });

  it('offers temp and local variables the document uses, and the parameters of its widgets', () => {
    const doc = ':: Widgets [widget]\n{widget "w" @p _q}{@p}{/widget}\n:: Start\n{set _t = 1}{_';
    expect(at(doc, 3, 15)).toEqual(expect.arrayContaining(['_t', '_q']));
    expect(at(':: Widgets [widget]\n{widget "w" @p}{@p}{/widget}\n:: Start\n{@', 3, 2)).toEqual(['@p']);
  });

  it('offers nothing in a script passage, and edits CRLF documents at the right range', () => {
    expect(at(':: Code [script]\nvar o = {', 1, 9)).toEqual([]);
    const ws = createWorkspace({ name: 'test.tw', content: ':: Start\r\n{if $x}\r\ntext {i' });
    const items = getCompletions('file:///test.tw', { line: 2, character: 7 }, undefined, ws);
    expect(items.find(i => i.label === 'if')?.textEdit).toMatchObject({ range: { start: { line: 2, character: 6 }, end: { line: 2, character: 7 } } });
  });

  it('offers passage names inside a link target only', () => {
    const doc = ':: Start\n[[Go->Se]] [[Se<-Go]]\n:: Second\nx';
    expect(at(doc, 1, 8)).toEqual(['Start', 'Second']);
    expect(at(doc, 1, 3)).toEqual([]);
    expect(at(doc, 1, 15)).toEqual(['Start', 'Second']);
    expect(at(doc, 1, 18)).toEqual([]);
  });
});
