import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { getDefinition } from '../../src/plugins/definition.js';

function createWorkspace(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const ws = new WorkspaceModel();
  const contents = new Map<string, string>();
  for (const f of files) {
    contents.set(`file:///${f.name}`, f.content);
  }
  ws.initialize(contents);
  return ws;
}

describe('getDefinition', () => {
  it('jumps to passage from [[link]]', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n[[Next]]\n\n:: Next\nHello',
    });
    // Position on "Next" in [[Next]] at line 1
    const result = getDefinition('file:///test.tw', { line: 1, character: 3 }, ws);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe('file:///test.tw');
    // Should point to the "Next" passage header
    expect(result!.range.start.line).toBe(3);
  });

  it('jumps to passage from [[Display|Target]]', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n[[Click here|Destination]]\n\n:: Destination\nYou arrived.',
    });
    // Position on "Destination" in the link
    const result = getDefinition('file:///test.tw', { line: 1, character: 15 }, ws);
    expect(result).not.toBeNull();
    expect(result!.range.start.line).toBe(3);
  });

  it('jumps to widget definition from invocation', () => {
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
    // Position on "greeting" at line 1, char 1 (after '{')
    const result = getDefinition('file:///test.tw', { line: 1, character: 2 }, ws);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe('file:///widgets.tw');
  });

  it('returns null for known macros (not widgets)', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{if $x}hello{/if}',
    });
    // Position on "if" — this is a builtin macro, not a widget
    const result = getDefinition('file:///test.tw', { line: 1, character: 2 }, ws);
    expect(result).toBeNull();
  });

  it('returns null when cursor is on plain text', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\nJust some text',
    });
    const result = getDefinition('file:///test.tw', { line: 1, character: 5 }, ws);
    expect(result).toBeNull();
  });

  it('jumps to passage from {goto "passage"}', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{goto "Next"}\n\n:: Next\nArrived.',
    });
    // Position on "Next" inside the goto
    const result = getDefinition('file:///test.tw', { line: 1, character: 8 }, ws);
    expect(result).not.toBeNull();
    expect(result!.range.start.line).toBe(3);
  });
});
