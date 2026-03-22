import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDocumentSymbols } from '../../src/plugins/document-symbol.js';
import { SymbolKind } from 'vscode-languageserver';

function createWorkspace(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const ws = new WorkspaceModel();
  const contents = new Map<string, string>();
  for (const f of files) {
    contents.set(`file:///${f.name}`, f.content);
  }
  ws.initialize(contents);
  return ws;
}

describe('computeDocumentSymbols', () => {
  it('returns passage symbols as Namespace kind', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\nHello world\n\n:: Next\nGoodbye',
    });
    const symbols = computeDocumentSymbols('file:///test.tw', ws);
    expect(symbols).toHaveLength(2);
    expect(symbols[0].name).toBe('Start');
    expect(symbols[0].kind).toBe(SymbolKind.Namespace);
    expect(symbols[1].name).toBe('Next');
    expect(symbols[1].kind).toBe(SymbolKind.Namespace);
  });

  it('returns passage range covering full passage content', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\nLine 1\nLine 2\n\n:: Next\nContent',
    });
    const symbols = computeDocumentSymbols('file:///test.tw', ws);
    // Start passage should cover from line 0 to before Next (line 3)
    expect(symbols[0].range.start.line).toBe(0);
    expect(symbols[0].range.end.line).toBe(3);
    // Next passage should cover from line 4 to end
    expect(symbols[1].range.start.line).toBe(4);
  });

  it('nests widget definitions under widget passages', () => {
    const ws = createWorkspace({
      name: 'widgets.tw',
      content: ':: MyWidgets [widget]\n{widget "greeting" @name}\nHello {@name}!\n{/widget}',
    });
    const symbols = computeDocumentSymbols('file:///widgets.tw', ws);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('MyWidgets');
    expect(symbols[0].children).toBeDefined();
    expect(symbols[0].children!.length).toBeGreaterThanOrEqual(1);

    const widgetChild = symbols[0].children!.find(c => c.name === 'greeting');
    expect(widgetChild).toBeDefined();
    expect(widgetChild!.kind).toBe(SymbolKind.Function);
  });

  it('nests variable declarations under StoryVariables', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$health = 100\n$name = "Player"\n\n:: Start\nContent',
    });
    const symbols = computeDocumentSymbols('file:///test.tw', ws);

    const svSymbol = symbols.find(s => s.name === 'StoryVariables');
    expect(svSymbol).toBeDefined();
    expect(svSymbol!.children).toBeDefined();
    expect(svSymbol!.children!.length).toBe(2);
    expect(svSymbol!.children![0].name).toBe('$health');
    expect(svSymbol!.children![0].kind).toBe(SymbolKind.Variable);
    expect(svSymbol!.children![1].name).toBe('$name');
  });

  it('returns empty array for unknown document', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\nContent',
    });
    const symbols = computeDocumentSymbols('file:///unknown.tw', ws);
    expect(symbols).toEqual([]);
  });
});
