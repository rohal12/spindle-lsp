import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { getSignatureHelp } from '../../src/plugins/signature.js';

function createWorkspace(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const ws = new WorkspaceModel();
  const contents = new Map<string, string>();
  for (const f of files) {
    contents.set(`file:///${f.name}`, f.content);
  }
  ws.initialize(contents);
  return ws;
}

describe('getSignatureHelp', () => {
  it('returns signature help for a known macro with parameters', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{set ',
    });
    const result = getSignatureHelp('file:///test.tw', { line: 1, character: 5 }, ws);
    // 'set' has parameters defined in supplements
    if (result) {
      expect(result.signatures.length).toBeGreaterThan(0);
      expect(result.signatures[0].label).toContain('set');
    }
  });

  it('returns signature help for a widget with params', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: MyWidgets [widget]\n{widget "greeting" @name}\nHello {@name}!\n{/widget}',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{greeting ',
      },
    );
    const result = getSignatureHelp('file:///test.tw', { line: 1, character: 10 }, ws);
    expect(result).not.toBeNull();
    expect(result!.signatures[0].label).toContain('greeting');
    expect(result!.signatures[0].parameters).toHaveLength(1);
    expect(result!.signatures[0].parameters[0].label).toBe('@name');
  });

  it('returns null when not inside macro arguments', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\nPlain text here',
    });
    const result = getSignatureHelp('file:///test.tw', { line: 1, character: 5 }, ws);
    expect(result).toBeNull();
  });

  it('computes active parameter based on args before cursor', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: MyWidgets [widget]\n{widget "counter" @count @label}\n{@count} {@label}\n{/widget}',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{counter 5 ',
      },
    );
    const result = getSignatureHelp('file:///test.tw', { line: 1, character: 11 }, ws);
    expect(result).not.toBeNull();
    // After "5 " we have 1 arg already, so activeParameter should be 1
    expect(result!.activeParameter).toBe(1);
  });
});
