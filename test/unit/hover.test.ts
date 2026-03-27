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
      content: ':: StoryVariables\n$player = { health: 100, mana: 50 }\n\n:: Start\n$player.health',
    });
    const result = getHoverInfo('file:///test.tw', { line: 4, character: 2 }, ws);
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
      content: ':: StoryTransients\n%state = { phase: 1, active: true }\n\n:: Start\n%state.phase',
    });
    const result = getHoverInfo('file:///test.tw', { line: 4, character: 2 }, ws);
    expect(result).not.toBeNull();
    expect(result!.contents).toContain('Transient variable');
    expect(result!.contents).toContain('phase');
    expect(result!.contents).toContain('active');
  });
});
