import { describe, it, expect, vi } from 'vitest';
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

  it('nests widgets defined with single-quoted and bare names', () => {
    const ws = createWorkspace({
      name: 'widgets.tw',
      content: ":: MyWidgets [widget]\n{widget 'hello' @name}Hi{/widget}\n{widget bye $who}Bye{/widget}",
    });
    const symbols = computeDocumentSymbols('file:///widgets.tw', ws);
    expect(symbols[0].children!.map(c => c.name)).toEqual(['hello', 'bye']);
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

  it('ends the selection range before the CR of a CRLF header', () => {
    const ws = createWorkspace({ name: 'test.tw', content: ':: Start\r\nHello\r\n:: Next\nBye\r\n' });
    const symbols = computeDocumentSymbols('file:///test.tw', ws);
    expect(symbols.map(s => s.selectionRange.end)).toEqual([{ line: 0, character: 8 }, { line: 2, character: 7 }]);
    expect(symbols[0].range.end).toEqual({ line: 1, character: 5 });
  });

  it.each([[16, 8], [32, 16]])('indexes widgets once for %i passages and %i widgets (#312)', (passageCount, widgetCount) => {
    const uri = 'file:///widgets.tw';
    const ws = createWorkspace({
      name: 'widgets.tw',
      content: Array.from({ length: passageCount }, (_, i) =>
        `:: P${i} [widget]\n${i < widgetCount ? `{widget "w${i}"}Hi{/widget}` : 'Hi'}\n`).join(''),
    }, {
      name: 'other.tw',
      content: ':: Other [widget]\n{widget "outside"}Other{/widget}',
    });
    let widgetVisits = 0;
    for (const widget of ws.widgets.getAllWidgets()) {
      const widgetUri = widget.uri;
      Object.defineProperty(widget, 'uri', { get: () => { widgetVisits++; return widgetUri; } });
    }
    const widgets = vi.spyOn(ws.widgets, 'getAllWidgets');
    try {
      const symbols = computeDocumentSymbols(uri, ws);
      expect(symbols).toHaveLength(passageCount);
      expect(symbols.map(s => s.children!.map(c => c.name))).toEqual(
        Array.from({ length: passageCount }, (_, i) => i < widgetCount ? [`w${i}`] : []),
      );
      expect(widgets).toHaveBeenCalledTimes(1);
      expect(widgetVisits).toBeLessThanOrEqual(widgetCount + 1);
      const first = symbols[0].children![0];
      // Tooling's definition range covers the opening registration token.
      expect(first.range).toEqual({ start: { line: 1, character: 0 }, end: { line: 1, character: 13 } });
      expect(first.selectionRange).toEqual({ start: { line: 1, character: 9 }, end: { line: 1, character: 11 } });
    } finally {
      widgets.mockRestore();
      ws.dispose();
    }
  });

  it('uses effective StoryInit widgets and refreshes the outline after edits and removals (#312)', () => {
    const uri = 'file:///widgets.tw';
    const other = 'file:///zother.tw';
    const ws = createWorkspace({
      name: 'widgets.tw',
      content: ':: StoryInit\n{widget "init"}Hi{/widget}\n:: W [widget]\n{widget "shared"}Old{/widget}\n{widget "local"}Here{/widget}',
    }, {
      name: 'zother.tw',
      content: ':: Other [widget]\n{widget "shared"}New{/widget}',
    });
    const names = () => computeDocumentSymbols(uri, ws).map(s => s.children!.map(c => c.name));
    try {
      expect(names()).toEqual([['init'], ['local']]);
      ws.documents.update(other, ':: Other\nNo widgets');
      expect(names()).toEqual([['init'], ['shared', 'local']]);
      ws.documents.update(uri, ':: StoryInit\n{widget "fresh"}New{/widget}\n:: W [widget]\nNone');
      expect(names()).toEqual([['fresh'], []]);
      ws.documents.close(uri);
      expect(computeDocumentSymbols(uri, ws)).toEqual([]);
    } finally {
      ws.dispose();
    }
  });
});
