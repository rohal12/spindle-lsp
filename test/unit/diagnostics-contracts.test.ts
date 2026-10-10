/**
 * Diagnostics source-context contracts moved from the convergence corpus
 * (X71 #71, X72/C-X72 #72, D78/C-D78 #78). See docs/reviews/process.md.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { deepTokens } from '../helpers/tooling.js';
import { parseStoryVariables } from '../helpers/story-variables-oracle.js';
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

describe('X71: macros in link labels are macros (#71)', () => {
  // The label of a link holds markup (Spindle 0.59): a macro in it is a real macro, paired and checked like any other
  // (before, a macro-looking label was text, so none of these were diagnosed)
  const macrosIn = (body: string) => deepTokens(body).filter(t => t.token.type === 'macro');

  it('X71: an {if} in a label pairs with its {/if}', () => {
    const body = '[[{if true}label{/if}|Next]]';
    expect(macrosIn(body).every(t => t.nested)).toBe(true);
    expect(macrosIn(body)).toHaveLength(2);
    const model = workspace(`:: StoryVariables\n:: Next\nhello\n:: Start\n${body}`);
    expect(codes(model)).toEqual([]);
  });
  it('X71: an unclosed {if} in a label is SP101, at the macro', () => {
    const body = '[[{if true}label|Next]]';
    expect(macrosIn(body)).toHaveLength(1);
    const model = workspace(`:: StoryVariables\n:: Next\nhello\n:: Start\n${body}`);
    const found = diags(model);
    expect(found.map(d => d.code)).toEqual(['SP101']);
    expect(found[0].message).toBe('In the label of a link: Unclosed {if}: no {/if} closes it');
    expect(found[0].range).toEqual({ start: { line: 4, character: 2 }, end: { line: 4, character: 11 } });
  });
  for (const [id, label, expected] of [['unknown', '{unknown}', 'SP100'], ['closing', '{/if}', 'SP101'], ['arrow', '{if true}', 'SP101']]) {
    it(`X71-${id}: a ${label} label is a macro, diagnosed as ${expected}`, () => {
      const body = id === 'arrow' ? `[[${label}label->Next]]` : `[[${label}x|Next]]`;
      expect(macrosIn(body)).toHaveLength(1);
      const model = workspace(`:: StoryVariables\n:: Next\nhello\n:: Start\n${body}`);
      expect(codes(model)).toEqual([expected]);
    });
  }
  it('C-X71: a real if block around a link with a macro label pairs both', () => {
    expect(codes(workspace(':: StoryVariables\n:: Next\nhi\n:: Start\n{if true}[[{if true}a{/if}|Next]]{/if}'))).toEqual([]);
    // the {if} in the label does not close the block around the link
    expect(codes(workspace(':: StoryVariables\n:: Next\nhi\n:: Start\n{if true}[[{if true}a|Next]]{/if}'))).toEqual(['SP101']);
    const model = workspace(':: StoryVariables\n:: Next\nhi\n:: Start\n[[a|Next]] {if true} [[b|Next]]');
    expect(codes(model)).toContain('SP101');
  });
  it('C-X71: an unclosed link does not mask the rest of the passage', () => {
    const model = workspace(':: StoryVariables\n:: Start\n[[oops {if true}');
    expect(codes(model)).toEqual(['SP105', 'SP101']);
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
    // null is a valid default in 0.59 (type null), not a declaration problem
    expect(codes(workspace(':: StoryVariables\n$x = null\n:: Start\nhello'))).not.toContain('SP204');
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
