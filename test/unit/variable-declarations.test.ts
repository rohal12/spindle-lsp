import { describe, it, expect } from 'vitest';
import { SymbolKind } from 'vscode-languageserver';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { findVariableReferences, findTransientReferences } from '../../src/plugins/references.js';
import { searchWorkspaceSymbols } from '../../src/plugins/workspace-symbol.js';

function createWorkspace(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const ws = new WorkspaceModel();
  const contents = new Map<string, string>();
  for (const f of files) {
    contents.set(`file:///${f.name}`, f.content);
  }
  ws.initialize(contents);
  return ws;
}

describe('variable declaration locations', () => {
  it('records the StoryVariables declaration URI and range', () => {
    const ws = createWorkspace(
      { name: 'vars.tw', content: ':: StoryVariables\n$x = 0\n  $obj = {a: 1}\n$gone = null' },
      { name: 'start.tw', content: ':: Start\n{$x}' },
    );
    const declared = ws.variables.getDeclared();
    expect(declared.get('x')).toMatchObject({
      declarationUri: 'file:///vars.tw',
      declarationRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } },
    });
    expect(declared.get('obj')).toMatchObject({
      declarationUri: 'file:///vars.tw',
      declarationRange: { start: { line: 2, character: 2 }, end: { line: 2, character: 6 } },
    });
    // null defaults are still declarations
    expect(declared.get('gone')).toMatchObject({
      declarationUri: 'file:///vars.tw',
      declarationRange: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } },
    });
  });

  it('records the StoryTransients declaration URI and range', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{%y}\n\n:: StoryTransients\n%y = 0\n%n = null',
    });
    const declared = ws.variables.getDeclaredTransient();
    expect(declared.get('y')).toMatchObject({
      declarationUri: 'file:///test.tw',
      declarationRange: { start: { line: 4, character: 0 }, end: { line: 4, character: 2 } },
    });
    expect(declared.get('n')).toMatchObject({
      declarationUri: 'file:///test.tw',
      declarationRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 2 } },
    });
  });

  it('includes the story variable declaration in references', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$x = 0\n:: Start\n{$x}',
    });
    expect(findVariableReferences('x', ws, true)).toEqual([
      { uri: 'file:///test.tw', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } } },
      { uri: 'file:///test.tw', range: { start: { line: 3, character: 1 }, end: { line: 3, character: 3 } } },
    ]);
  });

  it('includes the transient declaration in references', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryTransients\n%y = 0\n:: Start\n{%y}',
    });
    expect(findTransientReferences('y', ws, true)).toEqual([
      { uri: 'file:///test.tw', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } } },
      { uri: 'file:///test.tw', range: { start: { line: 3, character: 1 }, end: { line: 3, character: 3 } } },
    ]);
  });

  it('gives workspace symbols the declaration location', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$x = 0\n:: StoryTransients\n%y = 0\n:: Start\n{$x}{%y}',
    });
    const vars = searchWorkspaceSymbols('', ws).filter(s => s.kind === SymbolKind.Variable);
    expect(vars).toEqual([
      {
        name: '$x',
        kind: SymbolKind.Variable,
        uri: 'file:///test.tw',
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } },
      },
      {
        name: '%y',
        kind: SymbolKind.Variable,
        uri: 'file:///test.tw',
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 2 } },
      },
    ]);
  });
});
