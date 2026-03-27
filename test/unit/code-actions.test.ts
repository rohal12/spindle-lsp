import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeCodeActions } from '../../src/plugins/code-actions.js';
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

describe('computeCodeActions', () => {
  it('produces quick fix for SP100 (undefined macro)', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{unknownMacro "arg"}',
    });
    const diags = computeDiagnostics('file:///test.tw', ws);
    const sp100 = diags.filter(d => d.code === 'SP100');
    expect(sp100.length).toBeGreaterThan(0);

    const actions = computeCodeActions('file:///test.tw', sp100, ws);
    expect(actions.length).toBeGreaterThan(0);

    const action = actions[0];
    expect(action.title).toContain('unknownMacro');
    expect(action.title).toContain('spindle.config.yaml');
    expect(action.kind).toBe('quickfix');
    expect(action.diagnosticCodes).toContain('SP100');
    expect(action.edits.length).toBe(1);
    expect(action.edits[0].newText).toContain('unknownMacro');
  });

  it('produces quick fix for SP200 (undeclared variable)', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$health = 100\n\n:: Start\n{set $unknown = 1}',
    });
    const diags = computeDiagnostics('file:///test.tw', ws);
    const sp200 = diags.filter(d => d.code === 'SP200');
    expect(sp200.length).toBeGreaterThan(0);

    const actions = computeCodeActions('file:///test.tw', sp200, ws);
    expect(actions.length).toBeGreaterThan(0);

    const action = actions[0];
    expect(action.title).toContain('$unknown');
    expect(action.title).toContain('StoryVariables');
    expect(action.kind).toBe('quickfix');
    expect(action.diagnosticCodes).toContain('SP200');
    expect(action.edits.length).toBe(1);
    expect(action.edits[0].newText).toContain('$unknown = null');
  });

  it('produces quick fix for SP202 (no StoryVariables)', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{set $x = 1}',
    });
    const diags = computeDiagnostics('file:///test.tw', ws);
    const sp202 = diags.filter(d => d.code === 'SP202');
    expect(sp202.length).toBeGreaterThan(0);

    const actions = computeCodeActions('file:///test.tw', sp202, ws);
    expect(actions.length).toBeGreaterThan(0);

    const action = actions[0];
    expect(action.title).toBe('Create StoryVariables passage');
    expect(action.kind).toBe('quickfix');
    expect(action.diagnosticCodes).toContain('SP202');
    expect(action.edits.length).toBe(1);
    expect(action.edits[0].newText).toContain(':: StoryVariables');
  });

  it('produces quick fix for SP203 (undeclared transient variable)', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryTransients\n%known = 1\n\n:: Start\n{set %unknown = 1}',
    });
    const diags = computeDiagnostics('file:///test.tw', ws);
    const sp203 = diags.filter(d => d.code === 'SP203');
    expect(sp203.length).toBeGreaterThan(0);

    const actions = computeCodeActions('file:///test.tw', sp203, ws);
    expect(actions.length).toBeGreaterThan(0);

    const action = actions[0];
    expect(action.title).toContain('%unknown');
    expect(action.title).toContain('StoryTransients');
    expect(action.kind).toBe('quickfix');
    expect(action.diagnosticCodes).toContain('SP203');
    expect(action.edits.length).toBe(1);
    expect(action.edits[0].newText).toContain('%unknown = null');
  });

  it('returns no actions for non-actionable diagnostics', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: TestPassage\n{if $x}missing closing tag',
    });
    const diags = computeDiagnostics('file:///test.tw', ws);
    // SP101 (malformed container) has no quick fix
    const sp101 = diags.filter(d => d.code === 'SP101');
    expect(sp101.length).toBeGreaterThan(0);

    const actions = computeCodeActions('file:///test.tw', sp101, ws);
    expect(actions).toHaveLength(0);
  });

  it('returns no actions for empty diagnostics array', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\nHello world',
    });
    const actions = computeCodeActions('file:///test.tw', [], ws);
    expect(actions).toHaveLength(0);
  });

  it('SP200 fix inserts at end of StoryVariables passage', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryVariables\n$a = 1\n$b = 2\n\n:: Start\n{set $newVar = 1}',
    });
    const diags = computeDiagnostics('file:///test.tw', ws);
    const sp200 = diags.filter(d => d.code === 'SP200');

    const actions = computeCodeActions('file:///test.tw', sp200, ws);
    expect(actions.length).toBeGreaterThan(0);

    const edit = actions[0].edits[0];
    expect(edit.uri).toBe('file:///test.tw');
    // The insert should be at the blank line before :: Start (line 4)
    expect(edit.range.start.line).toBe(4);
  });
});
