import { describe, it, expect } from 'vitest';
import { SymbolKind } from 'vscode-languageserver';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { findReferences, findVariableReferences, findTransientReferences } from '../../src/plugins/references.js';
import { computeRename } from '../../src/plugins/rename.js';
import { getHoverInfo } from '../../src/plugins/hover.js';
import { computeSemanticTokensAbsolute } from '../../src/plugins/semantic-tokens.js';
import { getCompletions } from '../../src/plugins/completions.js';
import { computeInlayHints } from '../../src/plugins/inlay-hints.js';
import { computeDocumentSymbols } from '../../src/plugins/document-symbol.js';
import { computeCodeLenses } from '../../src/plugins/code-lens.js';
import { searchWorkspaceSymbols } from '../../src/plugins/workspace-symbol.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

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

describe('declaration reset when a special passage disappears', () => {
  const declarations = ':: StoryVariables\n$x = 0\n\n:: StoryTransients\n%y = 0\n\n';
  const start = ':: Start\n{$x} {%y}\n';

  function expectNoDeclarations(ws: WorkspaceModel): void {
    expect(ws.variables.hasStoryVariables()).toBe(false);
    expect(ws.variables.hasStoryTransients()).toBe(false);
    expect(ws.variables.getDeclared().size).toBe(0);
    expect(ws.variables.getDeclaredTransient().size).toBe(0);
  }

  it('clears declarations when the passages are deleted', () => {
    const ws = createWorkspace({ name: 'test.tw', content: declarations + start });
    expect(ws.variables.hasStoryVariables()).toBe(true);
    expect(ws.variables.hasStoryTransients()).toBe(true);

    ws.documents.update('file:///test.tw', start);
    expectNoDeclarations(ws);
    expect(computeDiagnostics('file:///test.tw', ws).map(d => d.code)).toContain('SP202');
  });

  it('clears declarations when the passages are renamed', () => {
    const ws = createWorkspace({ name: 'test.tw', content: declarations + start });
    ws.documents.update(
      'file:///test.tw',
      declarations.replace('StoryVariables', 'OldVariables').replace('StoryTransients', 'OldTransients') + start,
    );
    expectNoDeclarations(ws);
  });

  it('clears declarations when the declaring files are removed', () => {
    const ws = createWorkspace(
      { name: 'vars.tw', content: ':: StoryVariables\n$x = 0\n' },
      { name: 'transients.tw', content: ':: StoryTransients\n%y = 0\n' },
      { name: 'start.tw', content: start },
    );
    ws.documents.close('file:///vars.tw');
    expect(ws.variables.hasStoryVariables()).toBe(false);
    expect(ws.variables.getDeclared().size).toBe(0);
    expect(ws.variables.hasStoryTransients()).toBe(true);

    ws.documents.close('file:///transients.tw');
    expectNoDeclarations(ws);
  });
});

// Spindle's parseStoryVariables() reads each line as `^\$(\w+)\s*=\s*(.+)$`
// (`%` for StoryTransients), and its expression transform turns `$5` into
// variables["5"]: a name may start with a digit, but contains no `$`.
describe('variable names Spindle accepts (#62)', () => {
  const content = [
    ':: StoryVariables', // 0
    '$5 = 0', // 1
    '$9lives = {a: 1}', // 2
    ':: StoryTransients', // 3
    '%5 = 0', // 4
    ':: Start', // 5
    'It costs $5. {set $5 to $5 + 1}{$5}{%5}', // 6
  ].join('\n');
  const uri = 'file:///test.tw';

  it('declares names that start with a digit', () => {
    const ws = createWorkspace({ name: 'test.tw', content });
    expect(ws.variables.getDeclared().get('5')).toMatchObject({
      type: 'number',
      declarationRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } },
    });
    expect(ws.variables.getDeclared().get('9lives')).toMatchObject({ type: 'object', fields: ['a'] });
    expect(ws.variables.getDeclaredTransient().get('5')).toMatchObject({ type: 'number' });
  });

  it('does not declare names with a $ inside, which Spindle rejects', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$a$b = 1\n$$c = 2\n:: StoryTransients\n%d$e = 3',
    });
    expect([...ws.variables.getDeclared().keys()]).toEqual([]);
    expect([...ws.variables.getDeclaredTransient().keys()]).toEqual([]);
  });

  it('reports no SP200 for a declared $5, in prose or in code', () => {
    const ws = createWorkspace({ name: 'test.tw', content });
    const codes = computeDiagnostics(uri, ws).map(d => d.code);
    expect(codes).not.toContain('SP200');
    expect(codes).not.toContain('SP203');
  });

  it('finds the declaration and every usage of $5 and %5', () => {
    const ws = createWorkspace({ name: 'test.tw', content });
    const at = (character: number) => ({ start: { line: 6, character }, end: { line: 6, character: character + 2 } });
    expect(findReferences(uri, { line: 6, character: 25 }, ws, true)).toEqual([
      { uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } } },
      { uri, range: at(9) },
      { uri, range: at(18) },
      { uri, range: at(24) },
      { uri, range: at(32) },
    ]);
    expect(findReferences(uri, { line: 6, character: 37 }, ws, true)).toEqual([
      { uri, range: { start: { line: 4, character: 0 }, end: { line: 4, character: 2 } } },
      { uri, range: at(36) },
    ]);
  });

  it('finds $5 in string interpolations and quoted receivers', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$5 = 0\n:: Start\n{link "Pay {$5}" "Shop"}{textbox "$5"}',
    });
    expect(findVariableReferences('5', ws, false).map(r => r.range.start)).toEqual([
      { line: 3, character: 12 },
      { line: 3, character: 34 },
    ]);
  });

  it('renames $5 everywhere', () => {
    const ws = createWorkspace({ name: 'test.tw', content });
    const doc = TextDocument.create(uri, 'twee', 0, content);
    const edits = computeRename(uri, { line: 1, character: 1 }, '$price', ws).get(uri)!;
    const lines = TextDocument.applyEdits(doc, edits).split('\n');
    expect(lines[1]).toBe('$price = 0');
    expect(lines[6]).toBe('It costs $price. {set $price to $price + 1}{$price}{%5}');
  });

  it('hovers, highlights and completes $5 like any variable', () => {
    const ws = createWorkspace({ name: 'test.tw', content });
    expect(getHoverInfo(uri, { line: 6, character: 33 }, ws)?.contents).toContain('`$5`');
    const varTokens = computeSemanticTokensAbsolute(uri, ws)
      .filter(t => t.line === 6)
      .map(t => [t.startChar, t.length]);
    expect(varTokens).toEqual(expect.arrayContaining([[9, 2], [18, 2], [24, 2], [32, 2], [36, 2]]));

    const fieldWs = createWorkspace({ name: 'test.tw', content: content + '\n{$9lives.' });
    const items = getCompletions(uri, { line: 7, character: 10 }, '.', fieldWs);
    expect(items.map(i => i.label)).toEqual(['a']);
  });

  it('gives $5 a type hint, a document symbol and a usage count', () => {
    const ws = createWorkspace({ name: 'test.tw', content });
    const range = { start: { line: 0, character: 0 }, end: { line: 6, character: 0 } };
    const hints = computeInlayHints(uri, range, ws).map(h => [h.position.line, h.label]);
    expect(hints).toEqual(expect.arrayContaining([[1, ': number'], [2, ': object'], [4, ': number']]));

    const storyVars = computeDocumentSymbols(uri, ws).find(s => s.name === 'StoryVariables')!;
    expect(storyVars.children!.map(c => c.name)).toEqual(['$5', '$9lives']);

    const lenses = computeCodeLenses(uri, ws).filter(l => l.range.start.line === 1);
    expect(lenses.map(l => l.command.title)).toEqual(['4 usages']);
  });
});
