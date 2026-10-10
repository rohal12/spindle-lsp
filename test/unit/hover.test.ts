import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { getHoverInfo } from '../../src/plugins/hover.js';

function createWorkspace(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const ws = new WorkspaceModel();
  const contents = new Map<string, string>();
  for (const f of files) {
    contents.set(`file:///${f.name}`, f.content);
  }
  ws.initialize(contents);
  return ws;
}

describe('getHoverInfo', () => {
  it('returns macro info when hovering over a known macro', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{if $x}hello{/if}',
    });
    // Hover over 'if' at position (1, 1)
    const result = getHoverInfo('file:///test.tw', { line: 1, character: 1 }, ws);
    expect(result).not.toBeNull();
    expect(result!.contents).toContain('**if**');
    expect(result!.contents).toContain('container');
  });

  it('returns story variable info when hovering over $variable', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$health = 100\n\n:: Start\n{set $health = 50}',
    });
    // Hover over '$health' at line 4
    const result = getHoverInfo('file:///test.tw', { line: 4, character: 6 }, ws);
    expect(result).not.toBeNull();
    expect(result!.contents).toContain('Story variable');
    expect(result!.contents).toContain('health');
  });

  it('returns temp variable info when hovering over _variable', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{set _tempVar = 42}',
    });
    const result = getHoverInfo('file:///test.tw', { line: 1, character: 6 }, ws);
    expect(result).not.toBeNull();
    expect(result!.contents).toContain('Temp variable');
    expect(result!.contents).toContain('tempVar');
  });

  it('returns local variable info when hovering over @variable', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: MyWidget [widget]\n{widget "test" @name}\nHello {@name}!',
    });
    const result = getHoverInfo('file:///test.tw', { line: 2, character: 8 }, ws);
    expect(result).not.toBeNull();
    expect(result!.contents).toContain('Local variable');
    expect(result!.contents).toContain('name');
  });

  it('returns widget info when hovering over widget invocation', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: Widgets [widget]\n{widget "greeting" @name}\nHello, {@name}!\n{/widget}',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{greeting "World"}',
      },
    );
    const result = getHoverInfo('file:///test.tw', { line: 1, character: 2 }, ws);
    expect(result).not.toBeNull();
    expect(result!.contents).toContain('Widget');
    expect(result!.contents).toContain('greeting');
    expect(result!.contents).toContain('@name');
  });

  it('resolves widget hover case-insensitively', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: Widgets [widget]\n{widget "Greeting" @name}Hello, {@name}!{/widget}',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{greeting "World"}',
      },
    );
    const result = getHoverInfo('file:///test.tw', { line: 1, character: 2 }, ws);
    expect(result).not.toBeNull();
    expect(result!.contents).toContain('**Widget** `Greeting`');
  });

  it('shows the declared sigil of $ and _ widget params', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: Widgets [widget]\n{widget bye $who _how}Bye{/widget}',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{bye "Sam" 1}',
      },
    );
    const result = getHoverInfo('file:///test.tw', { line: 1, character: 2 }, ws);
    expect(result).not.toBeNull();
    expect(result!.contents).toContain('Parameters: $who, _how');
  });

  it('returns null for plain text', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\nJust some text',
    });
    const result = getHoverInfo('file:///test.tw', { line: 1, character: 5 }, ws);
    expect(result).toBeNull();
  });

  it('returns field info for story variable with fields', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$player = { health: 100, mana: 50 }\n\n:: Start\n{$player.health}',
    });
    const result = getHoverInfo('file:///test.tw', { line: 4, character: 3 }, ws);
    expect(result).not.toBeNull();
    expect(result!.contents).toContain('Story variable');
    expect(result!.contents).toContain('health');
    expect(result!.contents).toContain('mana');
  });

  it('returns transient variable info when hovering over %variable', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryTransients\n%npcList = []\n\n:: Start\n{set %npcList = [1, 2]}',
    });
    const result = getHoverInfo('file:///test.tw', { line: 4, character: 6 }, ws);
    expect(result).not.toBeNull();
    expect(result!.contents).toContain('Transient variable');
    expect(result!.contents).toContain('npcList');
  });

  it('returns field info for transient variable with fields', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryTransients\n%state = { phase: 1, active: true }\n\n:: Start\n{%state.phase}',
    });
    const result = getHoverInfo('file:///test.tw', { line: 4, character: 3 }, ws);
    expect(result).not.toBeNull();
    expect(result!.contents).toContain('Transient variable');
    expect(result!.contents).toContain('phase');
    expect(result!.contents).toContain('active');
  });
});

describe('getHoverInfo with CSS selector prefixes (#58)', () => {
  function hover(body: string, character: number) {
    const ws = createWorkspace({
      name: 'test.tw',
      content: `:: StoryVariables\n$player = { name: "Ann" }\n\n:: Start\n${body}`,
    });
    return getHoverInfo('file:///test.tw', { line: 4, character }, ws);
  }

  it('shows no macro for a class name ending in a macro name', () => {
    // {.cls-link $player} is a variable display; "link" is part of the class
    expect(hover('{.cls-link $player}', 7)).toBeNull();
  });

  it('shows the variable of a prefixed variable display', () => {
    const result = hover('{.hero-name $player.name}', 14);
    expect(result?.contents).toContain('Story variable');
  });

  it('finds the macro name after selectors that contain it', () => {
    const result = hover('{.link link "Go" "Next"}', 8);
    expect(result?.contents).toContain('**link**');
    expect(result?.range).toEqual({
      start: { line: 4, character: 7 },
      end: { line: 4, character: 11 },
    });
  });
});

// Spindle outputs a macro inside an attribute value as text (SP103).
describe('getHoverInfo inside HTML attribute values', () => {
  const content = ':: StoryVariables\n$x = 1\n:: Widgets [widget]\n{widget "Badge"}b{/widget}\n'
    + ':: Start\n<span class="{if $x}a{/if} {Badge}">t</span>{if $x}b{/if}\n';

  it('does not describe a macro or widget written inside an attribute value', () => {
    const ws = createWorkspace({ name: 'test.tw', content });
    expect(getHoverInfo('file:///test.tw', { line: 5, character: 15 }, ws)).toBeNull();
    expect(getHoverInfo('file:///test.tw', { line: 5, character: 29 }, ws)).toBeNull();
  });

  it('still describes variables there, and macros outside the tag', () => {
    const ws = createWorkspace({ name: 'test.tw', content });
    expect(getHoverInfo('file:///test.tw', { line: 5, character: 18 }, ws)?.contents).toContain('Story variable');
    expect(getHoverInfo('file:///test.tw', { line: 5, character: 45 }, ws)?.contents).toContain('**if**');
  });
});
