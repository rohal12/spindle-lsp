/**
 * #67 (residual): a passage rename spells the new name for the consumer that
 * reads each reference. Case IDs R67-*; the matrix cells for the same
 * contract are the passage-rename names in test/review/support/properties.ts
 * (RENAMES.passage) over the goto/include contexts of corpus.ts.
 * Runtime evaluation is limited to fixed benign literals written here.
 *
 * Spindle 0.59 reads the `passage` argument of {goto}, {include} and {link}
 * as a JavaScript string literal when it is quoted and as an expression
 * otherwise (`passageTarget`; there is no text fallback), so the only
 * references are quoted and every new name is spelled as a quoted literal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { tokenize } from '../helpers/tooling.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import type { Range } from '../../src/core/types.js';
import { computeRename, encodePassageRefName, RenameError } from '../../src/plugins/rename.js';
import { documentPassageRefs } from '../../src/core/markup/passage-refs.js';
import { gotoTarget } from '../review/support/oracle.js';
import { runtimeGotoTarget } from '../helpers/expression-oracle.js';

const uri = 'file:///story.tw';
const models: WorkspaceModel[] = [];
function workspace(text: string) {
  const model = new WorkspaceModel({ workspaceRoot: process.cwd() });
  model.initialize(new Map([[uri, text]]));
  models.push(model);
  return model;
}
afterEach(() => { for (const model of models.splice(0)) model.dispose(); });

function renamed(model: WorkspaceModel, name: string) {
  const edits = computeRename(uri, { line: 1, character: 5 }, name, model);
  const list: Array<{ range: Range; newText: string }> = edits.get(uri) ?? [];
  return TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, model.documents.getText(uri)!), list);
}
const source = (macro: string, args = '"Old"') => `:: StoryVariables\n:: Old\nhello\n:: Start\n{${macro} ${args}}`;
/** The passage names written out in `body`, a passage of its own. */
function names(body: string): string[] {
  const model = workspace(`:: Start\n${body}`);
  return documentPassageRefs(model.markup.get(uri)!).map(ref => ref.name);
}
/** Where the installed runtime navigates for the last macro of `output`. */
const navigates = (output: string, macro: 'goto' | 'include') =>
  gotoTarget(tokenize(output).filter(t => t.type === 'macro').at(-1)!.rawArgs, macro === 'include');

describe('R67: arithmetic and other evaluating names', () => {
  it('R67-goto-arithmetic: a name that would evaluate stays quoted, and navigates to the name', () => {
    const output = renamed(workspace(source('goto')), '1 + 2');
    expect(output).toContain(':: 1 + 2\n');
    expect(output).toContain('{goto "1 + 2"}');
    expect(navigates(output, 'goto')).toBe('1 + 2');
  });

  it('R67-spelling: every name is spelled as a quoted literal, whatever it looks like', () => {
    for (const name of [
      'New', 'New Name', 'Chapter 2', '_x1', 'URL', 'temporary', 'Image', '_x 1', 'a _b',
      '1 + 2', '5', 'a-b', 'true', 'null', 'Math', 'typeof x', 'a  b', 'a(b)', "it's", '$v',
    ]) {
      const spelled = JSON.stringify(name);
      expect(renamed(workspace(source('goto')), name), name).toContain(`{goto ${spelled}}`);
      expect(renamed(workspace(source('include')), name), name).toContain(`{include ${spelled}}`);
    }
  });

  it('R67-runtime-binding: renamed to a name Spindle binds, the target still navigates to the name (empty and populated scope)', () => {
    const scopes = [{}, { x1: 'Other', URL: 'Other', temporary: 'Other', Image: 'Other' }];
    for (const name of ['_x1', 'URL', 'temporary', 'Image', 'variables', 'Math', 'visited', 'New', 'Chapter 2']) {
      for (const macro of ['goto', 'include'] as const) {
        const output = renamed(workspace(`${source(macro)} {${macro} "Old"}`), name);
        const call = tokenize(output).filter(t => t.type === 'macro').map(t => t.rawArgs);
        expect(call.length, name).toBe(2);
        for (const args of call) for (const temporary of scopes) {
          expect(runtimeGotoTarget(args, temporary), `${macro} ${name} in ${JSON.stringify(temporary)}`).toBe(name);
        }
      }
    }
  });

  it('R67-runtime-oracle: the evaluator transforms sigils, so a bare _x1 and a global are values, not names', () => {
    expect(runtimeGotoTarget('_x1')).toBe('undefined');
    expect(runtimeGotoTarget('_x1', { x1: 'Other' })).toBe('Other');
    expect(runtimeGotoTarget('URL')).toMatch(/URL/);
    expect(runtimeGotoTarget('URL')).not.toBe('URL');
    expect(runtimeGotoTarget('temporary')).toBe('[object Object]');
    // Spindle 0.59 has no text fallback: a bare name is an expression, and one that does not evaluate throws
    // when the macro runs, so it navigates nowhere (the 0.45.1 component used its text as the name)
    expect(runtimeGotoTarget('Chapter 2')).toBeNull();
    expect(runtimeGotoTarget('Old')).toBeNull();
    expect(runtimeGotoTarget('"_x1"', { x1: 'Other' })).toBe('_x1');
    expect(runtimeGotoTarget('"Old"')).toBe('Old');
  });

  it('R67-classifier: only a quoted string names a passage; words, numbers and arithmetic are expressions', () => {
    for (const bare of ['1 + 2', '2024-05-01', '1.0', '5', 'Chapter 1', 'Chapter-1', 'Chapter', '`Chapter`']) {
      expect(names(`{goto ${bare}}`), bare).toEqual([]);
    }
    expect(names('{goto "5"} {goto \'Chapter 1\'}')).toEqual(['5', 'Chapter 1']);
  });
});

describe('R67: the {include} inline flag', () => {
  /** The reference to `Old` in `{include <args>}`. */
  function includeRef(args: string) {
    const model = workspace(source('include', args));
    const [ref] = documentPassageRefs(model.markup.get(uri)!);
    return ref;
  }

  it('R67-include-inline-quoted: inside quotes the word is no flag, so the name is written as is', () => {
    expect(encodePassageRefName(includeRef('"Old"'), 'inline')).toBe('inline');
    expect(encodePassageRefName(includeRef('"Old" inline'), 'New inline')).toBe('New inline');
    expect(encodePassageRefName(includeRef('inline "Old"'), 'inline New')).toBe('inline New');
    expect(encodePassageRefName(includeRef("'Old'"), "it's")).toBe("it\\'s");
  });

  it('R67-include-inline-installed: renaming to inline navigates to inline on the installed runtime', () => {
    for (const args of ['"Old"', '"Old" inline', 'inline "Old"']) {
      const output = renamed(workspace(source('include', args)), 'inline');
      expect(navigates(output, 'include'), args).toBe('inline');
      expect(output).toContain(':: inline\n');
    }
  });

  it('R67-include-flag-reading: the flag is the first or last word outside quotes; the name is the quoted string', () => {
    expect(names('{include "Old" inline}')).toEqual(['Old']);
    expect(names('{include inline "Old"}')).toEqual(['Old']);
    expect(names('{include "inline"}')).toEqual(['inline']);
    expect(names('{include "inline" inline}')).toEqual(['inline']);
    // what is left is an expression, not a name
    expect(names('{include Old inline}')).toEqual([]);
    expect(names('{include a inline b}')).toEqual([]);
    const ref = includeRef('inline "Old"');
    expect([ref.range.start.character, ref.range.end.character]).toEqual([17, 20]);
  });

  it('R67-atomic: a name another reference cannot hold rejects the whole rename', () => {
    const model = workspace(`${source('include')} [[Old]]`);
    expect(() => computeRename(uri, { line: 1, character: 5 }, '1 + 2|x', model)).toThrow(RenameError);
  });
});
