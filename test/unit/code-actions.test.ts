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

  it('declares a $ followed by digits in code, which Spindle reads as a variable (#62)', () => {
    // In prose `$5` is text; in code it is a variable
    const content = ':: StoryVariables\n$health = 100\n\n:: Start\nIt costs $5. {print $5}';
    const ws = createWorkspace({ name: 'test.tw', content });
    const sp200 = computeDiagnostics('file:///test.tw', ws).filter(d => d.code === 'SP200');
    expect(sp200.map(d => d.message)).toEqual(['Undeclared variable: $5']);

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
      content: ':: TestPassage\n{/set}',
    });
    const diags = computeDiagnostics('file:///test.tw', ws);
    // SP104 (a closing tag that closes nothing) has no quick fix
    const sp104 = diags.filter(d => d.code === 'SP104');
    expect(sp104.length).toBeGreaterThan(0);

    const actions = computeCodeActions('file:///test.tw', sp104, ws);
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

/** Apply the first action of `title` to the story and return the codes reported afterwards. */
function applyAndDiagnose(ws: WorkspaceModel, uri: string, diagnostics: ReturnType<typeof computeDiagnostics>, title: string | RegExp) {
  const actions = computeCodeActions(uri, diagnostics, ws);
  const action = actions.find(a => (typeof title === 'string' ? a.title === title : title.test(a.title)));
  expect(action, `${title} among ${JSON.stringify(actions.map(a => a.title))}`).toBeDefined();
  const doc = TextDocument.create(uri, 'twee', 0, ws.documents.getText(uri)!);
  const edits = action!.edits.filter(e => e.uri === uri).map(e => ({ range: e.range, newText: e.newText }));
  ws.documents.update(uri, TextDocument.applyEdits(doc, edits));
  return computeDiagnostics(uri, ws);
}

describe('computeCodeActions on the diagnostics of the tooling API', () => {
  const uri = 'file:///test.tw';
  const vars = ':: StoryVariables\n$x = 1\n\n';

  it('changes an unknown macro to the closest known one (SP100)', () => {
    const ws = createWorkspace({ name: 'test.tw', content: `${vars}:: Start\n{sett $x = 2}\n{.cls prnt $x}` });
    const sp100 = computeDiagnostics(uri, ws).filter(d => d.code === 'SP100');
    expect(sp100).toHaveLength(2);
    const titles = computeCodeActions(uri, sp100, ws).map(a => a.title);
    expect(titles).toEqual(expect.arrayContaining(["Change to '{set}'", "Change to '{print}'"]));

    const after = applyAndDiagnose(ws, uri, [sp100[0]], "Change to '{set}'");
    expect(ws.documents.getText(uri)).toContain('{set $x = 2}');
    expect(after.filter(d => d.code === 'SP100').map(d => d.message)).toEqual([expect.stringContaining('{prnt}')]);
    // the selectors of the second macro stay where they are
    const fixed = applyAndDiagnose(ws, uri, after.filter(d => d.code === 'SP100'), "Change to '{print}'");
    expect(ws.documents.getText(uri)).toContain('{.cls print $x}');
    expect(fixed).toEqual([]);
  });

  it('closes an unclosed block where the passage ends (SP101)', () => {
    const ws = createWorkspace({ name: 'test.tw', content: `${vars}:: Start\n{if $x}\none\n\n:: Other\ntwo\n` });
    const sp101 = computeDiagnostics(uri, ws).filter(d => d.code === 'SP101');
    expect(sp101).toHaveLength(1);
    const after = applyAndDiagnose(ws, uri, sp101, 'Insert {/if}');
    expect(ws.documents.getText(uri)).toBe(`${vars}:: Start\n{if $x}\none{/if}\n\n:: Other\ntwo\n`);
    expect(after).toEqual([]);
  });

  it('closes an unclosed element too (SP102), in a CRLF document', () => {
    const ws = createWorkspace({ name: 'test.tw', content: ':: Start\r\n<div>\r\none\r\n\r\n:: Other\r\ntwo\r\n' });
    const sp102 = computeDiagnostics(uri, ws).filter(d => d.code === 'SP102');
    expect(sp102).toHaveLength(1);
    const after = applyAndDiagnose(ws, uri, sp102, 'Insert </div>');
    expect(ws.documents.getText(uri)).toBe(':: Start\r\n<div>\r\none</div>\r\n\r\n:: Other\r\ntwo\r\n');
    expect(after).toEqual([]);
  });

  it('quotes a bare passage name (SP113)', () => {
    const ws = createWorkspace({ name: 'test.tw', content: ':: Start\n{goto Other}\n:: Other\ntwo\n' });
    const sp113 = computeDiagnostics(uri, ws).filter(d => d.code === 'SP113');
    expect(sp113).toHaveLength(1);
    const after = applyAndDiagnose(ws, uri, sp113, 'Quote the passage name: "Other"');
    expect(ws.documents.getText(uri)).toBe(':: Start\n{goto "Other"}\n:: Other\ntwo\n');
    expect(after).toEqual([]);
  });

  it('creates the passage of a broken link, or changes the link to a close name (SP300)', () => {
    const create = createWorkspace({ name: 'test.tw', content: ':: Start\n[[Go->Nowhere [1]]]\n' });
    const broken = computeDiagnostics(uri, create).filter(d => d.code === 'SP300');
    expect(broken).toHaveLength(1);
    const created = applyAndDiagnose(create, uri, broken, "Create passage 'Nowhere [1'");
    expect(create.documents.getText(uri)).toContain('\n:: Nowhere \\[1\n');
    expect(created.filter(d => d.code === 'SP300')).toEqual([]);

    const change = createWorkspace({ name: 'test.tw', content: ':: Start\n[[Hal]] {goto "Hal"} {link "x" \'Hal\'}y{/link}\n:: Hall\nx\n' });
    const links = computeDiagnostics(uri, change).filter(d => d.code === 'SP300');
    expect(links).toHaveLength(3);
    const titles = computeCodeActions(uri, links, change).map(a => a.title);
    expect(titles).toContain("Change to 'Hall'");
    // each keeps the way its name is written
    for (let i = 0; i < 3; i++) {
      const left = computeDiagnostics(uri, change).filter(d => d.code === 'SP300');
      applyAndDiagnose(change, uri, [left[0]], /^Change to 'Hall'$/);
    }
    expect(change.documents.getText(uri)).toBe(':: Start\n[[Hall]] {goto "Hall"} {link "x" \'Hall\'}y{/link}\n:: Hall\nx\n');
  });
});
