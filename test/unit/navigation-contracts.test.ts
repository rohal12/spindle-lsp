/**
 * Convergence contracts V73 (#73) and W74 (#74), moved from
 * test/review/convergence.review.ts once they passed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { tokenize } from '../../node_modules/@rohal12/spindle/src/markup/tokenizer.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import type { Range } from '../../src/core/types.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeRename, prepareRename } from '../../src/plugins/rename.js';
import { findReferences, findVariableReferences, findWidgetReferences } from '../../src/plugins/references.js';
import { getDefinition } from '../../src/plugins/definition.js';

const uri = 'file:///story.tw';
const models: WorkspaceModel[] = [];
function workspace(text: string, extra: Array<[string, string]> = []) {
  const model = new WorkspaceModel({ workspaceRoot: process.cwd() });
  model.initialize(new Map([...extra, [uri, text]]));
  models.push(model);
  return model;
}
afterEach(() => { for (const model of models.splice(0)) model.dispose(); });

function apply(text: string, edits: Array<{ range: Range; newText: string }>) {
  return TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, text), edits);
}
function codes(model: WorkspaceModel) {
  return computeDiagnostics(uri, model).map(d => d.code);
}

describe('V73: StoryInterface variables participate in navigation and rename (#73)', () => {
  it('V73: cross-file StoryInterface variables participate in rename (#73)', () => {
    const declUri = 'file:///vars.tw';
    const model = workspace(':: StoryInterface\n<div>{$x}</div>\n:: Start\nhello', [[declUri, ':: StoryVariables\n$x = 1']]);
    expect(findVariableReferences('x', model, true)).toHaveLength(2);
    const edits = computeRename(declUri, { line: 1, character: 2 }, 'y', model);
    const output = apply(model.documents.getText(uri)!, edits.get(uri) ?? []);
    expect(output).toContain('{$y}');
    const next = workspace(output, [[declUri, apply(model.documents.getText(declUri)!, edits.get(declUri) ?? [])]]);
    expect(codes(next)).not.toContain('SP200');
  });

  it('V73-path: property paths keep the path, only the base identifier changes', () => {
    const declUri = 'file:///vars.tw';
    const model = workspace(':: StoryInterface\n<div>{$p.hp}</div>\n:: Start\n{$p.hp}', [[declUri, ':: StoryVariables\n$p = {hp: 1}']]);
    const edits = computeRename(declUri, { line: 1, character: 2 }, 'q', model);
    const output = apply(model.documents.getText(uri)!, edits.get(uri) ?? []);
    expect(output).toBe(':: StoryInterface\n<div>{$q.hp}</div>\n:: Start\n{$q.hp}');
  });

  it('V73-transient: StoryInterface transients are renamed with the declaration', () => {
    const declUri = 'file:///vars.tw';
    const model = workspace(':: StoryInterface\n<div>{%t}</div>\n:: Start\n{%t}', [[declUri, ':: StoryTransients\n%t = 1']]);
    const edits = computeRename(declUri, { line: 1, character: 2 }, 'u', model);
    const output = apply(model.documents.getText(uri)!, edits.get(uri) ?? []);
    expect(output).toBe(':: StoryInterface\n<div>{%u}</div>\n:: Start\n{%u}');
  });

  it('V73-unsaved: an unsaved edit to StoryInterface feeds the same index', () => {
    const declUri = 'file:///vars.tw';
    const model = workspace(':: StoryInterface\nplain\n:: Start\nhello', [[declUri, ':: StoryVariables\n$x = 1']]);
    expect(findVariableReferences('x', model, true)).toHaveLength(1);
    model.documents.update(uri, ':: StoryInterface\n<div>{$x}</div>\n:: Start\nhello');
    expect(findVariableReferences('x', model, true)).toHaveLength(2);
  });

  it('C-V73: StoryVariables declarations stay outside the executable usage index', () => {
    const model = workspace(':: StoryVariables\n$x = 1\n:: Start\nhello');
    expect(findVariableReferences('x', model, false)).toHaveLength(0);
  });

  it('C-V73: StoryScript text is not an executable usage', () => {
    const model = workspace(':: StoryVariables\n$x = 1\n:: StoryScript\n$x\n:: Start\nhello');
    expect(findVariableReferences('x', model, false)).toHaveLength(0);
  });
});

describe('W74: widget spelling shared by navigation and edits (#74)', () => {
  const declUri = 'file:///widgets.tw';
  for (const [id, name, prefix] of [['css', 'greeting', '.red '], ['hyphen', 'hello-world', '']]) {
    it(`W74-${id}: definition, references, and applied rename`, () => {
      const model = workspace(`:: StoryVariables\n:: Start\n{${prefix}${name} "Alice"}`, [[declUri, `:: Widgets [widget]\n{widget "${name}" @x}\n{@x}\n{/widget}`]]);
      expect(tokenize(model.documents.getText(uri)!).filter(t => t.type === 'macro').map(t => t.name)).toContain(name);
      expect(getDefinition(uri, { line: 2, character: prefix.length + 2 }, model)?.uri).toBe(declUri);
      expect(findWidgetReferences(name, model, false)).toHaveLength(1);
      const edits = computeRename(declUri, { line: 1, character: 11 }, 'renamed', model);
      expect(apply(model.documents.getText(uri)!, edits.get(uri) ?? [])).toContain(`{${prefix}renamed "Alice"}`);
    });

    it(`W74-${id}-invocation: references, prepareRename and rename start from the call`, () => {
      const model = workspace(`:: StoryVariables\n:: Start\n{${prefix}${name} "Alice"}`, [[declUri, `:: Widgets [widget]\n{widget "${name}" @x}\n{@x}\n{/widget}`]]);
      const position = { line: 2, character: prefix.length + 2 };
      expect(findReferences(uri, position, model, false)).toHaveLength(1);
      expect(findReferences(uri, position, model, true)).toHaveLength(2);
      expect(prepareRename(uri, position, model)?.placeholder).toBe(name);
      const edits = computeRename(uri, position, 'renamed', model);
      expect(apply(model.documents.getText(uri)!, edits.get(uri) ?? [])).toBe(`:: StoryVariables\n:: Start\n{${prefix}renamed "Alice"}`);
      expect(apply(model.documents.getText(declUri)!, edits.get(declUri) ?? [])).toContain('{widget "renamed" @x}');
    });
  }

  it('C-W74: block widget closing tag and bare call are renamed together', () => {
    const model = workspace(':: StoryVariables\n:: Start\n{.box wrap}hi{/wrap}\n{wrap}x{/wrap}', [[declUri, ':: Widgets [widget]\n{widget "wrap" block}{@children}{/widget}']]);
    const heads = findWidgetReferences('wrap', model, false);
    expect(heads).toHaveLength(4);
  });

  it('C-W74: HTML attribute text and string literals do not invent invocations', () => {
    const model = workspace(':: StoryVariables\n:: Start\n<a title="{greeting}">x</a>\n{print "{greeting}"}', [[declUri, ':: Widgets [widget]\n{widget "greeting"}hi{/widget}']]);
    expect(findWidgetReferences('greeting', model, false)).toHaveLength(0);
  });

  it('C-W74: built-in macro names take precedence over widgets', () => {
    const model = workspace(':: StoryVariables\n:: Start\n{if true}x{/if}', [[declUri, ':: Widgets [widget]\n{widget "if"}hi{/widget}']]);
    expect(getDefinition(uri, { line: 2, character: 2 }, model)).toBeNull();
  });

  describe('G74: stray closers are not widget references (#74 follow-up)', () => {
    const block = [[declUri, ':: Widgets [widget]\n{widget "wrap" block}{@children}{/widget}\n{widget "my-box" block}{@children}{/widget}']] as Array<[string, string]>;
    const stray = ':: StoryVariables\n:: Start\n{/wrap}\n{wrap}x{/wrap}\n{/wrap}';

    it('G74: unmatched closers are excluded from references', () => {
      const model = workspace(stray, block);
      const refs = findReferences(uri, { line: 3, character: 2 }, model, false);
      expect(refs.map(r => r.range.start.line).sort()).toEqual([3, 3]);
      expect(findWidgetReferences('wrap', model, false)).toHaveLength(2);
    });

    it('G74: stray closer has no prepareRename, rename or definition', () => {
      const model = workspace(stray, block);
      expect(prepareRename(uri, { line: 2, character: 3 }, model)).toBeNull();
      expect(getDefinition(uri, { line: 2, character: 3 }, model)).toBeNull();
      expect(findReferences(uri, { line: 2, character: 3 }, model, false)).toEqual([]);
      expect(prepareRename(uri, { line: 4, character: 3 }, model)).toBeNull();
    });

    it('G74: rename applied leaves stray closers untouched', () => {
      const model = workspace(stray, block);
      const edits = computeRename(uri, { line: 3, character: 2 }, 'renamed', model);
      expect(apply(model.documents.getText(uri)!, edits.get(uri) ?? []))
        .toBe(':: StoryVariables\n:: Start\n{/wrap}\n{renamed}x{/renamed}\n{/wrap}');
    });

    it('G74: closers do not pair across passages', () => {
      const model = workspace(':: StoryVariables\n:: A\n{wrap}x\n:: B\ny{/wrap}', block);
      expect(findWidgetReferences('wrap', model, false)).toHaveLength(1);
      expect(prepareRename(uri, { line: 4, character: 4 }, model)).toBeNull();
    });

    it('C-G74: paired closers (CSS-prefixed and hyphenated) stay references and rename together', () => {
      const model = workspace(':: StoryVariables\n:: Start\n{.box my-box}hi{/my-box}\n{#id wrap}x{/wrap}', block);
      expect(findWidgetReferences('my-box', model, false)).toHaveLength(2);
      expect(findWidgetReferences('wrap', model, false)).toHaveLength(2);
      expect(getDefinition(uri, { line: 2, character: 18 }, model)).not.toBeNull();
      expect(prepareRename(uri, { line: 2, character: 18 }, model)).not.toBeNull();
      const edits = computeRename(uri, { line: 2, character: 8 }, 'cell', model);
      expect(apply(model.documents.getText(uri)!, edits.get(uri) ?? [])).toContain('{.box cell}hi{/cell}');
    });
  });
});
