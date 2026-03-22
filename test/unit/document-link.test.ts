import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDocumentLinks } from '../../src/plugins/document-link.js';

function createWorkspace(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const ws = new WorkspaceModel();
  const contents = new Map<string, string>();
  for (const f of files) {
    contents.set(`file:///${f.name}`, f.content);
  }
  ws.initialize(contents);
  return ws;
}

describe('computeDocumentLinks', () => {
  it('returns links for [[passage]] references', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n[[Next]]\n\n:: Next\nContent',
    });
    const links = computeDocumentLinks('file:///test.tw', ws);
    expect(links.length).toBeGreaterThanOrEqual(1);
    const nextLink = links.find(l => l.target?.includes('test.tw'));
    expect(nextLink).toBeDefined();
    expect(nextLink!.target).toContain('#L4'); // Next is at line 3 (0-indexed), L4 (1-indexed)
  });

  it('returns links for [[Display|Target]] syntax', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n[[Click here|Destination]]\n\n:: Destination\nArrived',
    });
    const links = computeDocumentLinks('file:///test.tw', ws);
    expect(links.length).toBeGreaterThanOrEqual(1);
    const destLink = links.find(l => l.target?.includes('#L4'));
    expect(destLink).toBeDefined();
  });

  it('returns undefined target for unknown passages', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n[[NonExistent]]',
    });
    const links = computeDocumentLinks('file:///test.tw', ws);
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0].target).toBeUndefined();
  });

  it('returns links pointing to passages in other files', () => {
    const ws = createWorkspace(
      { name: 'a.tw', content: ':: Start\n[[Other]]' },
      { name: 'b.tw', content: ':: Other\nContent' },
    );
    const links = computeDocumentLinks('file:///a.tw', ws);
    expect(links.length).toBeGreaterThanOrEqual(1);
    const otherLink = links.find(l => l.target?.includes('b.tw'));
    expect(otherLink).toBeDefined();
  });

  it('returns empty array for unknown document', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\nContent',
    });
    const links = computeDocumentLinks('file:///unknown.tw', ws);
    expect(links).toEqual([]);
  });
});
