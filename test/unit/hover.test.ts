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

  it('shows the @ parameters of a widget, the only ones the runtime reads (parseWidgetDef)', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: Widgets [widget]\n{widget bye $who _how @whom}Bye{/widget}',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{bye "Sam" 1}',
      },
    );
    const result = getHoverInfo('file:///test.tw', { line: 1, character: 2 }, ws);
    expect(result).not.toBeNull();
    expect(result!.contents).toContain('Parameters: @whom');
    expect(result!.contents).not.toContain('$who');
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

// An HTML attribute value holds markup of its own (Spindle 0.59): the macros, widgets and
// variables in it are real, and text in a comment or in prose is not.
describe('getHoverInfo inside HTML attribute values and labels', () => {
  const content = ':: StoryVariables\n$x = 1\n:: Widgets [widget]\n{widget "Badge"}b{/widget}\n'
    + ':: Start\n<span class="{if $x}a{/if} {Badge}">t</span>{if $x}b{/if}\n';

  it('describes a macro or widget written inside an attribute value', () => {
    const ws = createWorkspace({ name: 'test.tw', content });
    expect(getHoverInfo('file:///test.tw', { line: 5, character: 15 }, ws)?.contents).toContain('**if**');
    expect(getHoverInfo('file:///test.tw', { line: 5, character: 29 }, ws)?.contents).toContain('**Widget** `Badge`');
  });

  it('describes variables there, and macros outside the tag', () => {
    const ws = createWorkspace({ name: 'test.tw', content });
    expect(getHoverInfo('file:///test.tw', { line: 5, character: 18 }, ws)?.contents).toContain('Story variable');
    expect(getHoverInfo('file:///test.tw', { line: 5, character: 45 }, ws)?.contents).toContain('**if**');
  });

  it('describes a macro and a variable in the label of a link or a button', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n[[Go {_k}->Start]] {button "Press {if $x}now{/if}"}x{/button}',
    });
    expect(getHoverInfo('file:///test.tw', { line: 1, character: 7 }, ws)?.contents).toContain('Temp variable');
    expect(getHoverInfo('file:///test.tw', { line: 1, character: 36 }, ws)?.contents).toContain('**if**');
  });
});

describe('getHoverInfo on text the runtime reads as text', () => {
  it('describes nothing in an HTML comment, or in prose, whatever it looks like', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$x = 1\n:: Start\n<!-- {if $x}a{/if} {$x} -->\nprose $x and _t and @a\n{print "$x _t"}',
    });
    for (const [line, character] of [[3, 7], [3, 13], [3, 20], [4, 7], [4, 14], [4, 21], [5, 10], [5, 12]]) {
      expect(getHoverInfo('file:///test.tw', { line, character }, ws), `${line}:${character}`).toBeNull();
    }
  });

  it('describes the declaration of a variable, and a variable after a CRLF', () => {
    const ws = createWorkspace({ name: 'test.tw', content: ':: StoryVariables\r\n$x = { a: 1 }\r\n:: Start\r\n{set _a = 1}\r\n{$x.a}' });
    expect(getHoverInfo('file:///test.tw', { line: 1, character: 1 }, ws)?.contents).toContain('Story variable');
    const hover = getHoverInfo('file:///test.tw', { line: 4, character: 4 }, ws);
    expect(hover?.contents).toContain('`$x.a`');
    expect(hover?.range).toEqual({ start: { line: 4, character: 1 }, end: { line: 4, character: 5 } });
  });
});
