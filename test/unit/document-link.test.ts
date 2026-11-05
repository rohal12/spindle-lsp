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
  it.each([64, 128])('bounds passage visits for %i distinct destinations (#254)', count => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n' + Array.from({ length: count }, (_, i) => `[[P${i}]]\n:: P${i}\n`).join(''),
    });
    try {
      computeDocumentLinks('file:///test.tw', ws); // Warm markup/reference caches.
      const passages = ws.passages.getPassagesInDocument('file:///test.tw');
      let visits = 0;
      Object.defineProperty(passages, Symbol.iterator, {
        value: function* () {
          for (let i = 0; i < passages.length; i++) {
            visits++;
            yield passages[i];
          }
        },
      });
      const links = computeDocumentLinks('file:///test.tw', ws);
      expect(links.map(link => link.target)).toEqual(Array.from({ length: count }, (_, i) => `file:///test.tw#L${i * 2 + 3}`));
      expect(visits).toBeLessThanOrEqual(passages.length * 2);
    } finally { ws.dispose(); }
  });

  it('refreshes duplicate destinations in compiler order after edits and removals (#254)', () => {
    const ws = createWorkspace(
      { name: 'z.tw', content: ':: Target\nlast file\n:: Target\nlast declaration' },
      { name: 'a.tw', content: ':: Start\n[[Target]] [[Missing]]\n:: Target\nfirst file' },
    );
    const targets = () => computeDocumentLinks('file:///a.tw', ws).map(link => link.target);
    try {
      expect(targets()).toEqual(['file:///z.tw#L3', undefined]);
      ws.documents.update('file:///z.tw', ':: Other\ntext\n\n:: Target\nnew line');
      expect(targets()).toEqual(['file:///z.tw#L4', undefined]);
      ws.documents.close('file:///z.tw');
      expect(targets()).toEqual(['file:///a.tw#L3', undefined]);
      ws.documents.update('file:///a.tw', ':: Start\n[[Target]] [[Missing]]');
      expect(targets()).toEqual([undefined, undefined]);
      ws.documents.open('file:///b.tw', ':: Target\nrestored');
      expect(targets()).toEqual(['file:///b.tw#L1', undefined]);
    } finally { ws.dispose(); }
  });

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
