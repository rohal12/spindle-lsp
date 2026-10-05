import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeCodeActions } from '../../src/plugins/code-actions.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

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
    expect(action.edits[0].newText).toContain('$unknown = 0');
  });

  it('declares a $ followed by digits, which Spindle reads as a variable (#62)', () => {
    const content = ':: StoryVariables\n$health = 100\n\n:: Start\nIt costs $5.';
    const ws = createWorkspace({ name: 'test.tw', content });
    const sp200 = computeDiagnostics('file:///test.tw', ws).filter(d => d.code === 'SP200');
    expect(sp200.map(d => d.message)).toEqual(["Variable '$5' is not declared in StoryVariables"]);

    const actions = computeCodeActions('file:///test.tw', sp200, ws);
    expect(actions.map(a => a.title)).toEqual(["Declare '$5' in StoryVariables"]);

    const doc = TextDocument.create('file:///test.tw', 'twee', 0, content);
    ws.documents.update('file:///test.tw', TextDocument.applyEdits(doc, actions[0].edits));
    expect(computeDiagnostics('file:///test.tw', ws).filter(d => d.code === 'SP200')).toEqual([]);
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
    expect(action.edits[0].newText).toContain('%unknown = 0');
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

describe('computeCodeActions for SP103 (macro in an HTML attribute)', () => {
  const vars = ':: StoryVariables\n$n = 1\n$s = "a"\n';

  function fixes(line: string) {
    const ws = createWorkspace({ name: 'test.tw', content: `${vars}:: Start\n${line}\n` });
    const diags = computeDiagnostics('file:///test.tw', ws).filter(d => d.code === 'SP103');
    return { diags, actions: computeCodeActions('file:///test.tw', diags, ws) };
  }

  it('rewrites {if C}A{else}B{/if} as {C ? \'A\' : \'B\'}', () => {
    const { diags, actions } = fixes('<span class="{if @d.delta > 0}delta-positive{else}delta-negative{/if}">x</span>');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      title: "Rewrite as {@d.delta > 0 ? 'delta-positive' : 'delta-negative'}",
      kind: 'quickfix',
      diagnosticCodes: ['SP103'],
    });
    expect(actions[0].edits).toEqual([{
      uri: 'file:///test.tw',
      range: diags[0].range,
      newText: "{@d.delta > 0 ? 'delta-positive' : 'delta-negative'}",
    }]);
  });

  it('rewrites {if C}A{/if} with an empty else branch', () => {
    const { actions } = fixes(`<div class='card {if $s == "a"}active{/if}'>x</div>`);
    expect(actions.map(a => a.edits[0].newText)).toEqual([`{$s == "a" ? 'active' : ''}`]);
  });

  it('rewrites {print E} as {E}', () => {
    const { diags, actions } = fixes(`<span class="d {print $n > 0 ? 'pos' : 'neg'}">x</span>`);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ title: "Rewrite as {$n > 0 ? 'pos' : 'neg'}", diagnosticCodes: ['SP103'] });
    expect(actions[0].edits).toEqual([{ uri: 'file:///test.tw', range: diags[0].range, newText: "{$n > 0 ? 'pos' : 'neg'}" }]);
  });

  it('offers no fix for other blocks', () => {
    expect(fixes('<span class="{print !$n}">x</span>').actions).toEqual([]);
    expect(fixes('<span class="{print $s + \'}\'}">x</span>').actions).toEqual([]);
    expect(fixes('<span class="{if !$n}a{/if}">x</span>').actions).toEqual([]);
    expect(fixes('<span class="{if $n}a{elseif $s}b{/if}">x</span>').actions).toEqual([]);
    expect(fixes('<span class="{for _i range 3}a{/for}">x</span>').actions).toEqual([]);
    expect(fixes(`<span class="{!$n ? 'a' : 'b'}">x</span>`).actions).toEqual([]);
  });
});
