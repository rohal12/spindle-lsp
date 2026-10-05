import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import type { DiagnosticOptions } from '../../src/plugins/diagnostics.js';

function createWorkspaceFrom(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const model = new WorkspaceModel();
  const fileContents = new Map<string, string>();
  for (const f of files) {
    fileContents.set(`file:///${f.name}`, f.content);
  }
  model.initialize(fileContents);
  return model;
}

function diagnose(text: string, options?: DiagnosticOptions) {
  const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
  return computeDiagnostics('file:///test.tw', workspace, options);
}

function codes(text: string, code: string, options?: DiagnosticOptions) {
  return diagnose(text, options).filter(d => d.code === code);
}

describe('SP101: container nesting and passage boundaries', () => {
  it('reports containers that would pair across passages', () => {
    const sp101 = codes(':: Start\n{if true}\n:: Other\n{/if}', 'SP101');
    expect(sp101).toHaveLength(2);
    expect(sp101.map(d => d.range.start.line).sort()).toEqual([1, 3]);
  });

  it('reports crossed containers in one passage', () => {
    const sp101 = codes(':: Start\n{if true}{for @x of []}{/if}{/for}', 'SP101');
    expect(sp101).toHaveLength(2);
    expect(sp101.some(d => d.message.includes('no matching {/for}'))).toBe(true);
    expect(sp101.some(d => d.message.includes('no matching {for}'))).toBe(true);
  });

  it('accepts properly nested containers', () => {
    const sp101 = codes(':: Start\n{if true}{for @x of []}{/for}{/if}\n:: Other\n{if false}x{/if}', 'SP101');
    expect(sp101).toHaveLength(0);
  });
});
