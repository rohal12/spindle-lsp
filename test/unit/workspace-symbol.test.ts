import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { searchWorkspaceSymbols } from '../../src/plugins/workspace-symbol.js';
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

describe('searchWorkspaceSymbols', () => {
  it('returns all passages with empty query', () => {
    const ws = createWorkspace(
      { name: 'a.tw', content: ':: Start\nHello' },
      { name: 'b.tw', content: ':: End\nBye' },
    );
    const symbols = searchWorkspaceSymbols('', ws);
    const passages = symbols.filter(s => s.kind === SymbolKind.Namespace);
    expect(passages.length).toBeGreaterThanOrEqual(2);
    const names = passages.map(s => s.name);
    expect(names).toContain('Start');
    expect(names).toContain('End');
  });

  it('filters symbols by case-insensitive substring', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StartPage\nContent\n\n:: EndPage\nContent\n\n:: Other\nContent',
    });
    const symbols = searchWorkspaceSymbols('page', ws);
    const names = symbols.map(s => s.name);
    expect(names).toContain('StartPage');
    expect(names).toContain('EndPage');
    expect(names).not.toContain('Other');
  });

  it('includes widgets as Function symbols', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: MyWidgets [widget]\n{widget "greeting" @name}\nHello {@name}!\n{/widget}',
      },
      { name: 'test.tw', content: ':: Start\n{greeting "World"}' },
    );
    const symbols = searchWorkspaceSymbols('greeting', ws);
    const widgetSymbol = symbols.find(s => s.kind === SymbolKind.Function);
    expect(widgetSymbol).toBeDefined();
    expect(widgetSymbol!.name).toBe('greeting');
  });

  it('includes declared variables as Variable symbols', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$health = 100\n\n:: Start\nContent',
    });
    const symbols = searchWorkspaceSymbols('health', ws);
    const varSymbol = symbols.find(s => s.kind === SymbolKind.Variable);
    expect(varSymbol).toBeDefined();
    expect(varSymbol!.name).toBe('$health');
  });
});
