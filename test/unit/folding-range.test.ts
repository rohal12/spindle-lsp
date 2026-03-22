import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeFoldingRanges } from '../../src/plugins/folding-range.js';

function createWorkspace(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const ws = new WorkspaceModel();
  const contents = new Map<string, string>();
  for (const f of files) {
    contents.set(`file:///${f.name}`, f.content);
  }
  ws.initialize(contents);
  return ws;
}

describe('computeFoldingRanges', () => {
  it('returns folding ranges for passages', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\nLine 1\nLine 2\n\n:: Next\nContent here',
    });
    const ranges = computeFoldingRanges('file:///test.tw', ws);
    const passageRanges = ranges.filter(r => r.kind === 'region');
    expect(passageRanges.length).toBeGreaterThanOrEqual(1);
    // Start passage: line 0 to line 3
    const startRange = passageRanges.find(r => r.startLine === 0);
    expect(startRange).toBeDefined();
    expect(startRange!.endLine).toBeGreaterThan(0);
  });

  it('returns folding ranges for block macros', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{if $x}\nTrue branch\n{/if}\nAfter',
    });
    const ranges = computeFoldingRanges('file:///test.tw', ws);
    // Should have at least one block macro range (if...endif)
    const macroRanges = ranges.filter(r => r.kind === undefined);
    expect(macroRanges.length).toBeGreaterThanOrEqual(1);
    const ifRange = macroRanges.find(r => r.startLine === 1);
    expect(ifRange).toBeDefined();
    expect(ifRange!.endLine).toBe(3);
  });

  it('returns empty array for unknown document', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\nContent',
    });
    const ranges = computeFoldingRanges('file:///unknown.tw', ws);
    expect(ranges).toEqual([]);
  });

  it('does not fold single-line passages', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: OnlyPassage',
    });
    const ranges = computeFoldingRanges('file:///test.tw', ws);
    // A passage that occupies only one line should not produce a folding range
    const passageRanges = ranges.filter(r => r.kind === 'region');
    expect(passageRanges).toHaveLength(0);
  });
});
