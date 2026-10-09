/**
 * Diagnostics source-context contracts moved from the convergence corpus
 * (X71 #71, X72/C-X72 #72, D78/C-D78 #78). See docs/reviews/process.md.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { tokenize } from '../helpers/tooling.js';
import { parseStoryVariables } from '../../node_modules/@rohal12/spindle/src/story-variables.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeCodeActions } from '../../src/plugins/code-actions.js';

const uri = 'file:///story.tw';
const models: WorkspaceModel[] = [];
function workspace(text: string, extra: Array<[string, string]> = []) {
  const model = new WorkspaceModel({ workspaceRoot: process.cwd() });
  model.initialize(new Map([...extra, [uri, text]]));
  models.push(model);
  return model;
}
afterEach(() => { for (const model of models.splice(0)) model.dispose(); });
const diags = (model: WorkspaceModel, u = uri) => computeDiagnostics(u, model);
const codes = (model: WorkspaceModel, u = uri) => diags(model, u).map(d => d.code);

describe('X71: macro-looking link labels remain labels (#71)', () => {
  it('X71: {if} in a label causes no SP101', () => {
    const body = '[[{if true}label|Next]]';
    expect(tokenize(body).filter(t => t.type === 'macro')).toHaveLength(0);
    const model = workspace(`:: StoryVariables\n:: Next\nhello\n:: Start\n${body}`);
    expect(codes(model)).not.toContain('SP101');
  });
  for (const [id, label] of [['unknown', '{unknown}'], ['closing', '{/if}'], ['arrow', '{if true}']]) {
    it(`X71-${id}: ${label} label is neither SP100 nor SP101/SP104`, () => {
      const body = id === 'arrow' ? `[[${label}label->Next]]` : `[[${label}x|Next]]`;
      expect(tokenize(body).filter(t => t.type === 'macro')).toHaveLength(0);
      const model = workspace(`:: StoryVariables\n:: Next\nhello\n:: Start\n${body}`);
      expect(codes(model).filter(c => c !== 'SP300')).toEqual([]);
    });
  }
  it('C-X71: a real if block next to a link still pairs and is diagnosed', () => {
    expect(codes(workspace(':: StoryVariables\n:: Next\nhi\n:: Start\n{if true}[[{if true}a|Next]]{/if}'))).toEqual([]);
    const model = workspace(':: StoryVariables\n:: Next\nhi\n:: Start\n[[a|Next]] {if true} [[b|Next]]');
    expect(codes(model)).toContain('SP101');
  });
  it('C-X71: an unclosed link does not mask the rest of the passage', () => {
    const model = workspace(':: StoryVariables\n:: Start\n[[oops {if true}');
    expect(codes(model)).toContain('SP101');
  });
  it('C-X71: a link inside macro arguments does not hide following macros', () => {
    const model = workspace(':: StoryVariables\n:: Next\nhi\n:: Start\n{print "[["} {if true} ]] ');
    expect(codes(model)).toContain('SP101');
  });
});

describe('X72: non-markup passage bodies (#72)', () => {
  for (const passage of ['StoryVariables', 'StoryTransients', 'StoryData']) {
    const sigil = passage === 'StoryTransients' ? '%' : '$';
    for (const [variant, value] of [['if', '{if true}'], ['unknown', '{unknown}'], ['link', '[[{if true}x|Nowhere]]']]) {
      it(`X72-${passage}${variant === 'if' ? '' : '-' + variant}: valid data strings receive no markup diagnostics`, () => {
        const body = passage === 'StoryData'
          ? `{"format":"Spindle","note":"${value}"}`
          : `${sigil}v = "${value}"`;
        if (passage !== 'StoryData') expect(parseStoryVariables(body, sigil).get('v')?.default).toBe(value);
        const extra = passage === 'StoryVariables' ? '' : ':: StoryVariables\n';
        const model = workspace(`${extra}:: ${passage}\n${body}\n:: Start\nhello`);
        const found = codes(model);
        for (const c of ['SP100', 'SP101', 'SP104', 'SP300']) expect(found).not.toContain(c);
      });
    }
  }
  it('C-X72: invalid declarations still receive declaration diagnostics', () => {
    expect(codes(workspace(':: StoryVariables\n$x = null\n:: Start\nhello'))).toContain('SP204');
    expect(codes(workspace(':: StoryVariables\n$x = "{if true}"\nnot a declaration\n:: Start\nhello'))).toEqual(['SP207']);
  });
  it('C-X72: executable special passages keep markup diagnostics', () => {
    for (const passage of ['StoryInit', 'StoryInterface']) {
      expect(codes(workspace(`:: StoryVariables\n:: ${passage}\n{if true}\n:: Start\nhello`))).toContain('SP101');
    }
  });
});

describe('D78: StoryVariables is required by the runtime (#78)', () => {
  const data = ':: StoryData\n{"format":"Spindle"}\n';
  it('D78: explicit Spindle story without variable usage is diagnosed as an error', () => {
    const found = diags(workspace(`${data}:: Start\nhello`)).filter(d => d.code === 'SP202');
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
  });
  it('D78: reported once across files, after the whole workspace is loaded', () => {
    const other = 'file:///other.tw';
    const model = workspace(`${data}:: Start\nhello`, [[other, ':: Other\nhi']]);
    const total = [uri, other].flatMap(u => diags(model, u)).filter(d => d.code === 'SP202');
    expect(total).toHaveLength(1);
  });
  it('D78: no diagnostics before the workspace scan completes', () => {
    const model = new WorkspaceModel({ workspaceRoot: process.cwd() });
    models.push(model);
    expect(computeDiagnostics(uri, model)).toEqual([]);
  });
  it('D78: offers the create-passage quick fix, which clears the diagnostic', () => {
    const model = workspace(`${data}:: Start\nhello`);
    const sp202 = diags(model).filter(d => d.code === 'SP202');
    const action = computeCodeActions(uri, sp202, model).find(a => a.title === 'Create StoryVariables passage')!;
    expect(action).toBeDefined();
    const edit = action.edits[0];
    model.documents.update(uri, TextDocument.applyEdits(
      TextDocument.create(uri, 'twee', 0, model.documents.getText(uri)!),
      [{ range: edit.range, newText: edit.newText }],
    ));
    expect(codes(model)).not.toContain('SP202');
  });
  it('C-D78: an empty StoryVariables passage satisfies the requirement', () => {
    expect(codes(workspace(`${data}:: StoryVariables\n:: Start\nhello`))).not.toContain('SP202');
  });
  it('C-D78: a declaration in another file satisfies the requirement', () => {
    const model = workspace(`${data}:: Start\nhello`, [['file:///vars.tw', ':: StoryVariables\n']]);
    expect(codes(model)).not.toContain('SP202');
  });
  it('C-D78: a story in another format is excluded', () => {
    expect(codes(workspace(':: StoryData\n{"format":"SugarCube"}\n:: Start\nhello'))).toEqual([]);
  });
  it('C-D78: a format-undeclared project keeps the usage-conditioned info diagnostic', () => {
    expect(codes(workspace(':: Start\nhello'))).not.toContain('SP202');
    const found = diags(workspace(':: Start\n{set $x = 1}')).filter(d => d.code === 'SP202');
    expect(found.map(d => d.severity)).toEqual(['info']);
  });
});
