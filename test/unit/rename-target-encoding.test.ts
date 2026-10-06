/**
 * #67 (residual): a passage rename spells the new name for the consumer that
 * reads each reference. Case IDs R67-*; the matrix cells for the same
 * contract are the passage-rename names in test/review/support/properties.ts
 * (RENAMES.passage) over the goto/include contexts of corpus.ts.
 * Runtime evaluation is limited to fixed benign literals written here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { tokenize } from '../../node_modules/@rohal12/spindle/src/markup/tokenizer.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import type { Range } from '../../src/core/types.js';
import { computeRename, encodePassageRefName, RenameError } from '../../src/plugins/rename.js';
import { parseMacroPassageRefs, type PassageRef } from '../../src/core/parsing/link-parser.js';
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
const source = (macro: string, args = 'Old') => `:: StoryVariables\n:: Old\nhello\n:: Start\n{${macro} ${args}}`;
/** Where the installed runtime navigates for the last macro of `output`. */
const navigates = (output: string, macro: 'goto' | 'include') =>
  gotoTarget(tokenize(output).filter(t => t.type === 'macro').at(-1)!.rawArgs, macro === 'include');

describe('R67: arithmetic and other evaluating names', () => {
  it('R67-goto-arithmetic: a bare target that would evaluate is quoted, and navigates to the name', () => {
    const output = renamed(workspace(source('goto')), '1 + 2');
    expect(output).toContain(':: 1 + 2\n');
    expect(output).toContain('{goto "1 + 2"}');
    expect(navigates(output, 'goto')).toBe('1 + 2');
  });

  it('R67-bare-spelling: only names certain to throw (several plain words) stay bare; a single word is quoted', () => {
    for (const [name, spelled] of [
      ['New', '"New"'], ['New Name', 'New Name'], ['Chapter 2', 'Chapter 2'], ['_x1', '"_x1"'], ['URL', '"URL"'],
      ['temporary', '"temporary"'], ['Image', '"Image"'], ['_x 1', '"_x 1"'], ['a _b', '"a _b"'],
      ['1 + 2', '"1 + 2"'], ['5', '"5"'], ['a-b', '"a-b"'], ['true', '"true"'], ['null', '"null"'], ['Math', '"Math"'],
      ['typeof x', '"typeof x"'], ['a  b', '"a  b"'], ['a(b)', '"a(b)"'], ["it's", '"it\'s"'], ['$v', '"$v"'],
    ]) {
      expect(renamed(workspace(source('goto')), name), name).toContain(`{goto ${spelled}}`);
      expect(renamed(workspace(source('include')), name), name).toContain(`{include ${spelled}}`);
    }
  });

  it('R67-runtime-binding: renamed to a name Spindle binds, the target still navigates to the name (empty and populated scope)', () => {
    const scopes = [{}, { x1: 'Other', URL: 'Other', temporary: 'Other', Image: 'Other' }];
    for (const name of ['_x1', 'URL', 'temporary', 'Image', 'variables', 'Math', 'visited', 'New', 'Chapter 2']) {
      for (const macro of ['goto', 'include'] as const) {
        const output = renamed(workspace(`${source(macro)} {${macro} Old}`), name);
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
    expect(runtimeGotoTarget('Chapter 2')).toBe('Chapter 2');
    expect(runtimeGotoTarget('"_x1"', { x1: 'Other' })).toBe('_x1');
  });

  it('R67-classifier: numeric expressions are not static names; canonical numbers and words are', () => {
    expect(parseMacroPassageRefs('{goto 1 + 2}')).toEqual([]);
    expect(parseMacroPassageRefs('{goto 2024-05-01}')).toEqual([]);
    expect(parseMacroPassageRefs('{goto 1.0}')).toEqual([]);
    expect(parseMacroPassageRefs('{goto 5}').map(r => r.name)).toEqual(['5']);
    expect(parseMacroPassageRefs('{goto Chapter 1}').map(r => r.name)).toEqual(['Chapter 1']);
    expect(parseMacroPassageRefs('{goto Chapter-1}').map(r => r.name)).toEqual(['Chapter-1']);
  });
});

describe('R67: the {include} inline flag per release', () => {
  const includeRef = (form: 'js-string' | 'bare'): PassageRef => ({
    name: 'Old', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    source: 'macro', form, macro: 'include', quote: form === 'js-string' ? '"' : undefined,
  });

  it('R67-include-inline-0.45.1: the first inline word is removed even inside quotes, so it is escaped', () => {
    for (const form of ['js-string', 'bare'] as const) {
      const spelled = encodePassageRefName(includeRef(form), 'inline', {});
      expect(spelled).toBe(form === 'bare' ? '"\\u0069nline"' : '\\u0069nline');
      const args = form === 'bare' ? spelled : `"${spelled}"`;
      // Spindle 0.45.1: remove the first \binline\b, then evaluate the rest
      expect(new Function(`return (${args.replace(/\binline\b/, '')})`)()).toBe('inline');
    }
    const encoded = encodePassageRefName(includeRef('js-string'), 'a\\inline "inline"', {});
    expect(encoded).not.toMatch(/\binline\b/);
    expect(new Function(`return ("${encoded}")`)()).toBe('a\\inline "inline"');
    expect(encodePassageRefName(includeRef('js-string'), 'Plain', {})).toBe('Plain');
  });

  it('R67-include-inline-0.51.1: inside quotes the word is not the flag; bare it would be', () => {
    const after = { includeInlineScoped: true };
    expect(encodePassageRefName(includeRef('js-string'), 'inline', after)).toBe('inline');
    expect(encodePassageRefName(includeRef('bare'), 'inline', after)).toBe('"inline"');
    expect(encodePassageRefName(includeRef('bare'), 'New inline', after)).toBe('"New inline"');
    expect(encodePassageRefName(includeRef('bare'), 'inline New', after)).toBe('"inline New"');
    expect(encodePassageRefName(includeRef('bare'), 'New Name', after)).toBe('New Name');
  });

  it('R67-include-inline-goto: the inline word is no concern of {goto}', () => {
    const ref = { ...includeRef('js-string'), macro: 'goto' };
    expect(encodePassageRefName(ref, 'inline', {})).toBe('inline');
    // a single word is quoted whatever the macro (it may be a binding)
    expect(encodePassageRefName({ ...ref, form: 'bare' }, 'inline', {})).toBe('"inline"');
  });

  it('R67-include-inline-installed: renaming to inline navigates to inline on the installed runtime', () => {
    for (const args of ['"Old"', 'Old', '"Old" inline', 'inline "Old"', 'Old inline']) {
      const output = renamed(workspace(source('include', args)), 'inline');
      expect(navigates(output, 'include'), args).toBe('inline');
      expect(output).toContain(':: inline\n');
    }
  });

  it('R67-include-flag-reading: the flag is found per release (0.45.1 anywhere, 0.51.1 standalone at an end)', () => {
    const names = (text: string, options = {}) => parseMacroPassageRefs(text, 0, options).map(r => r.name);
    const scoped = { includeInlineScoped: true };
    for (const options of [{}, scoped]) {
      expect(names('{include Old inline}', options)).toEqual(['Old']);
      expect(names('{include inline "Old"}', options)).toEqual(['Old']);
      expect(names('{include "Old" inline}', options)).toEqual(['Old']);
    }
    expect(names('{include "inline"}', scoped)).toEqual(['inline']);
    expect(names('{include "inline"}')).toEqual([]);
    expect(names('{include New inline}', scoped)).toEqual(['New']);
    expect(names('{include a inline b}', scoped)).toEqual(['a inline b']);
    const [ref] = parseMacroPassageRefs('{include inline "Old"}', 0, scoped);
    expect([ref.range.start.character, ref.range.end.character]).toEqual([17, 20]);
  });

  it('R67-atomic: a name another reference cannot hold rejects the whole rename', () => {
    const model = workspace(`${source('include')} [[Old]]`);
    expect(() => computeRename(uri, { line: 1, character: 5 }, '1 + 2|x', model)).toThrow(RenameError);
  });
});
