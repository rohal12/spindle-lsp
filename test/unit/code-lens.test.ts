import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { findVariableReferences, findWidgetReferences } from '../../src/plugins/references.js';
import { computeCodeLenses } from '../../src/plugins/code-lens.js';
import { parseStoryVariables } from '../helpers/story-variables-oracle.js';

function createWorkspace(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const ws = new WorkspaceModel();
  const contents = new Map<string, string>();
  for (const f of files) {
    contents.set(`file:///${f.name}`, f.content);
  }
  ws.initialize(contents);
  return ws;
}

describe('computeCodeLenses', () => {
  it.each([64, 128])('bounds cached header reads for %i passage lenses (#236)', count => {
    const uri = 'file:///test.tw';
    const content = Array.from({ length: count }, (_, i) => `:: P${i}\n[[P0]]\n`).join('');
    const ws = createWorkspace({ name: 'test.tw', content });
    try {
      computeCodeLenses(uri, ws);
      const headers = ws.passages.getPassagesInDocument(uri);
      let headerReads = 0;
      // Instrument the real index, retaining its array and header identities.
      // Any full header comparison now costs one read per passage.
      headers.forEach((header, i) => Object.defineProperty(headers, i, {
        configurable: true,
        get: () => { headerReads++; return header; },
      }));

      const lenses = computeCodeLenses(uri, ws);
      expect(lenses).toHaveLength(count);
      expect(lenses[0].command.title).toBe(`${count} references`);
      expect(lenses.slice(1).every(lens => lens.command.title === '0 references')).toBe(true);
      expect(headerReads).toBeLessThanOrEqual(count * 2);
    } finally {
      ws.dispose();
    }
  });

  it('shows reference count for passage headers', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n[[Next]]\n\n:: Next\nContent\n[[Start]]',
    });
    const lenses = computeCodeLenses('file:///test.tw', ws);
    expect(lenses.length).toBeGreaterThanOrEqual(2);

    // Find the lens for "Start" passage
    const startLens = lenses.find(l => l.range.start.line === 0);
    expect(startLens).toBeDefined();
    expect(startLens!.command.title).toContain('reference');

    // Find the lens for "Next" passage
    const nextLens = lenses.find(l => l.range.start.line === 3);
    expect(nextLens).toBeDefined();
    expect(nextLens!.command.title).toContain('reference');
  });

  it('refreshes cached reference counts and ranges after header and link edits (#236)', () => {
    const uri = 'file:///test.tw';
    const ws = createWorkspace({ name: 'test.tw', content: ':: Start\n[[Next]]\n:: Next\nEnd' });
    const counts = () => computeCodeLenses(uri, ws).map(lens => [lens.range.start.line, lens.command.title]);
    try {
      expect(counts()).toEqual([[0, '0 references'], [2, '1 reference']]);
      ws.documents.update(uri, ':: Start\n[[Next]]\n\n:: Renamed\nEnd');
      expect(counts()).toEqual([[0, '0 references'], [3, '0 references']]);
      ws.documents.update(uri, ':: Start\n[[Renamed]] [[Renamed]]\n\n:: Renamed\nEnd');
      expect(counts()).toEqual([[0, '0 references'], [3, '2 references']]);
    } finally {
      ws.dispose();
    }
  });

  it('shows usage count for widget definitions', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: MyWidgets [widget]\n{widget "greeting" @name}\nHello {@name}!\n{/widget}',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{greeting "World"}\n{greeting "Earth"}',
      },
    );
    const lenses = computeCodeLenses('file:///widgets.tw', ws);
    const widgetLens = lenses.find(l =>
      l.command.title.includes('usage'),
    );
    expect(widgetLens).toBeDefined();
    expect(widgetLens!.command.title).toContain('2 usages');
  });

  it('shows usage count for bare-name widget definitions', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: MyWidgets [widget]\n{widget bye $who}Bye{/widget}',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{bye "World"}',
      },
    );
    const lenses = computeCodeLenses('file:///widgets.tw', ws);
    const widgetLens = lenses.find(l => l.range.start.line === 1);
    expect(widgetLens?.command.title).toBe('1 usage');
  });

  it('shows usage count for StoryVariables declarations', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$health = 100\n\n:: Start\n{set $health = 50}\n{if $health > 0}ok{/if}',
    });
    const lenses = computeCodeLenses('file:///test.tw', ws);
    const varLens = lenses.find(l =>
      l.range.start.line === 1 && l.command.title.includes('usage'),
    );
    expect(varLens).toBeDefined();
  });

  it.each(['\n', '\r\n', '\r'])('uses declaration locations for usage lenses with %j line endings (#213)', eol => {
    const declarations = '$health = 100\n  $mana = 20\n\t$health = 50';
    expect([...parseStoryVariables(declarations).keys()]).toEqual(['health', 'mana']);
    const ws = createWorkspace({
      name: 'test.tw',
      content: `:: StoryVariables\n${declarations}\n:: Start\n{$health} {$health} {$mana}`.replaceAll('\n', eol),
    });
    const lenses = computeCodeLenses('file:///test.tw', ws).filter(l => l.command.title.includes('usage'));
    expect(lenses).toEqual([
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 13 } }, command: { title: '2 usages' } },
      { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 12 } }, command: { title: '1 usage' } },
      { range: { start: { line: 3, character: 0 }, end: { line: 3, character: 13 } }, command: { title: '2 usages' } },
    ]);
    ws.dispose();
  });

  it('moves declaration usage lenses with the effective StoryVariables passage and live edits (#213)', () => {
    const ws = createWorkspace(
      { name: 'a.tw', content: ':: StoryVariables\n$health = 100\n:: Start\n{$health}' },
      { name: 'b.tw', content: ':: StoryVariables [replace]\n  $health = 50' },
    );
    const usages = (uri: string) => computeCodeLenses(uri, ws).filter(l => l.command.title.includes('usage'));
    expect(usages('file:///a.tw')).toEqual([]);
    expect(usages('file:///b.tw')).toEqual([
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 14 } }, command: { title: '1 usage' } },
    ]);
    ws.documents.update('file:///b.tw', ':: StoryVariables [replace]\n\n\t$health = 25');
    expect(usages('file:///b.tw')).toEqual([
      { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 13 } }, command: { title: '1 usage' } },
    ]);
    ws.documents.update('file:///b.tw', ':: Notes\n  $health = 25');
    expect(usages('file:///b.tw')).toEqual([]);
    expect(usages('file:///a.tw').map(l => l.command.title)).toEqual(['1 usage']);
    ws.dispose();
  });

  it('does not show declaration usage lenses for compiler-omitted StoryVariables (#213)', () => {
    const ws = createWorkspace({ name: 'test.tw', content: ':: StoryVariables [script]\n$health = 100\n:: Start\n{$health}' });
    expect(computeCodeLenses('file:///test.tw', ws).filter(l => l.command.title.includes('usage'))).toEqual([]);
    ws.dispose();
  });

  it('counts references to a passage whose name has escaped brackets', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: A\\[B\\] [tag]\ntext\n\n:: Start\n{goto "A[B]"}\n{include "A[B]"}',
    });
    const lens = computeCodeLenses('file:///test.tw', ws).find(l => l.range.start.line === 0);
    expect(lens?.command.title).toBe('2 references');
  });

  it('skips StoryData passage', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryData\n{"ifid": "test"}\n\n:: Start\nContent',
    });
    const lenses = computeCodeLenses('file:///test.tw', ws);
    const storyDataLens = lenses.find(l => l.range.start.line === 0);
    expect(storyDataLens).toBeUndefined();
  });
});


describe('usage counts exclude non-invocations', () => {
  it.each([0, 1, 2])('counts %i block-widget invocations without their closers (#131)', (count) => {
    const ws = createWorkspace(
      { name: 'widgets.tw', content: ':: Widgets [widget]\n{widget "card"}{@children}{/widget}' },
      { name: 'story.tw', content: ':: Start\n' + '{card}body{/card}\n'.repeat(count) },
    );
    expect(computeCodeLenses('file:///widgets.tw', ws).find(l => l.range.start.line === 1)?.command.title)
      .toBe(`${count} usage${count === 1 ? '' : 's'}`);
    expect(findWidgetReferences('card', ws, true)).toHaveLength(1 + count * 2);
    ws.dispose();
  });

  it.each([0, 1])('counts %i variable usages despite repeated declarations (#132)', (count) => {
    const ws = createWorkspace({ name: 'story.tw', content: ':: StoryVariables\n$x = 1\n$x = 2\n:: Start\n' + '{$x}\n'.repeat(count) });
    const lenses = computeCodeLenses('file:///story.tw', ws).filter(l => [1, 2].includes(l.range.start.line));
    expect(lenses.map(l => l.command.title)).toEqual(Array(2).fill(`${count} usage${count === 1 ? '' : 's'}`));
    expect(findVariableReferences('x', ws, true)).toHaveLength(2 + count);
    ws.dispose();
  });
});
