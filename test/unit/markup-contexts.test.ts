/**
 * Convergence contracts for the markup contexts a macro-like text can sit in
 * (spindle-lsp-wt l-refs):
 *
 *  - L1: bracket-link labels that look like macros are link text for every
 *    consumer (passage references, variable usage, diagnostics, lenses,
 *    links, rename).
 *  - L2: passages Spindle does not tokenize as markup are masked by one
 *    helper that diagnostics, closer pairing, references and the rest share.
 *  - L4: crossed containers pair as Spindle's AST builder nests them.
 *
 * Edits are applied with TextDocument.applyEdits and the result is rebuilt
 * and reparsed. Every case runs with LF and CRLF.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { tokenize } from '../../node_modules/@rohal12/spindle/src/markup/tokenizer.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import type { Range } from '../../src/core/types.js';
import { computeCodeLenses } from '../../src/plugins/code-lens.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeDocumentLinks } from '../../src/plugins/document-link.js';
import { computeFoldingRanges } from '../../src/plugins/folding-range.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { computeRename, prepareRename } from '../../src/plugins/rename.js';
import { findPassageReferences, findVariableReferences, findWidgetReferences } from '../../src/plugins/references.js';
import { maskNonMarkupPassages } from '../../src/core/parsing/passage-parser.js';

const uri = 'file:///story.tw';
const widgetsUri = 'file:///widgets.tw';
const models: WorkspaceModel[] = [];
function workspace(text: string, extra: Array<[string, string]> = []) {
  const model = new WorkspaceModel({ workspaceRoot: process.cwd() });
  model.initialize(new Map([...extra, [uri, text]]));
  models.push(model);
  return model;
}
afterEach(() => { for (const model of models.splice(0)) model.dispose(); });

function apply(text: string, edits: Array<{ range: Range; newText: string }> | undefined) {
  return TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, text), edits ?? []);
}
function codes(model: WorkspaceModel, target = uri) {
  return computeDiagnostics(target, model).map(d => d.code);
}
/** Position of the first `needle` in `text`, `shift` characters in. */
function at(text: string, needle: string, shift = 0) {
  const offset = text.indexOf(needle);
  if (offset === -1) throw new Error(`no ${needle}`);
  return TextDocument.create(uri, 'twee', 0, text).positionAt(offset + shift);
}

const eols = [['LF', '\n'], ['CRLF', '\r\n']] as const;
const lines = (eol: string, ...rows: string[]) => rows.join(eol);

describe('L1: macro-looking bracket-link labels', () => {
  for (const [eolName, eol] of eols) {
    const text = lines(eol,
      ':: StoryVariables', '$x = 1', '%t = 2',
      ':: Start',
      '[[{goto "X"}->Target]]',
      '[[{if $x}label{/if}|Target]]',
      '[[Hi {$x}->Target]]',
      '[[{if %t}a{/if}->Target]]',
      ':: Target', 'end',
      ':: X', 'x',
      '');

    it(`L1-refs: passage references follow the link token (${eolName})`, () => {
      const model = workspace(text);
      // The tokenizer reads four links and no macro
      expect(tokenize(model.documents.getText(uri)!.split(/\r?\n/).slice(4, 8).join('\n')).map(t => t.type))
        .toEqual(['link', 'text', 'link', 'text', 'link', 'text', 'link']);
      expect(findPassageReferences('X', model, false)).toEqual([]);
      expect(findPassageReferences('Target', model, false)).toHaveLength(4);
      expect(getDefinition(uri, at(text, '->Target', 3), model)).not.toBeNull();
      // Inside the label, `{goto "X"}` points nowhere
      expect(getDefinition(uri, at(text, '"X"', 1), model)).toBeNull();
      expect(prepareRename(uri, at(text, '"X"', 1), model)).toBeNull();
    });

    it(`L1-links-lenses-diagnostics: links, lenses and diagnostics agree (${eolName})`, () => {
      const model = workspace(text);
      const links = computeDocumentLinks(uri, model);
      expect(links).toHaveLength(4);
      expect(links.every(link => link.target !== undefined)).toBe(true);
      const lens = (name: string) => computeCodeLenses(uri, model)
        .find(l => text.split(eol)[l.range.start.line] === `:: ${name}`)?.command?.title;
      expect(lens('Target')).toBe('4 references');
      expect(lens('X')).toBe('0 references');
      const found = codes(model);
      for (const code of ['SP100', 'SP101', 'SP104', 'SP300']) expect(found).not.toContain(code);
      // Spindle's startup validation still reads the raw `$x` in the label
      expect(found).not.toContain('SP200');
    });

    it(`L1-variables: only what the link interpolates is a usage (${eolName})`, () => {
      const model = workspace(text);
      const x = findVariableReferences('x', model, false);
      // `{$x}` in the third label is the only one: `{if $x}` is label text
      expect(x.map(r => r.range.start.line)).toEqual([6]);
      expect(model.variables.getTransientUsages('t')).toEqual([]);
    });

    it(`L1-rename: renaming a variable edits the interpolation and nothing else in the labels (${eolName})`, () => {
      const model = workspace(text);
      const edits = computeRename(uri, at(text, '{$x}', 2), 'y', model);
      const output = apply(text, edits.get(uri));
      expect(output).toContain('[[Hi {$y}->Target]]');
      expect(output).toContain('[[{if $x}label{/if}|Target]]');
      expect(output).toContain(`${eol}$y = 1`);
      // Reparse: the tokens differ only in the renamed interpolation
      const before = tokenize(text.replace(/\r\n/g, '\n'));
      const after = tokenize(output.replace(/\r\n/g, '\n'));
      expect(after.map(t => (t.type === 'link' ? [t.display.replace('$y', '$x'), t.target] : t.type)))
        .toEqual(before.map(t => (t.type === 'link' ? [t.display, t.target] : t.type)));
    });

    it(`L1-rename-passage: renaming the target edits the target, not the labels (${eolName})`, () => {
      const model = workspace(text);
      const edits = computeRename(uri, at(text, ':: Target', 4), 'Dest', model);
      const output = apply(text, edits.get(uri));
      expect(output).toContain('[[{goto "X"}->Dest]]');
      expect(output).toContain('[[{if $x}label{/if}|Dest]]');
      expect(output).toContain(':: Dest');
      const next = workspace(output);
      expect(codes(next)).not.toContain('SP300');
      expect(findPassageReferences('Dest', next, false)).toHaveLength(4);
      expect(findPassageReferences('X', next, false)).toEqual([]);
    });

    it(`C-L1: a link nested in a macro and a macro after a link keep working (${eolName})`, () => {
      const control = lines(eol,
        ':: StoryVariables', '$x = 1',
        ':: Start',
        '{if $x}[[a->Target]]{/if}{goto "X"}',
        '[[b->Target]]{if $x}{goto "Target"}{/if}',
        ':: Target', 'end', ':: X', 'x', '');
      const model = workspace(control);
      expect(findPassageReferences('X', model, false)).toHaveLength(1);
      expect(findPassageReferences('Target', model, false)).toHaveLength(3);
      expect(findVariableReferences('x', model, false)).toHaveLength(2);
    });
  }

  it('L1-passages: a link or macro never spans a passage header', () => {
    // Spindle renders each passage alone: `[[open` and `{if $x` are text, and
    // the `]]` and `}` in the next passage close nothing
    const model = workspace(':: StoryVariables\n$x = 1\n:: Start\n[[open\n{if $x\n:: Other\nx}} ]] {goto "X"} [[ok->Start]]\n:: X\nx\n');
    expect(findPassageReferences('X', model, false)).toHaveLength(1);
    expect(findPassageReferences('Start', model, false)).toHaveLength(1);
    expect(computeDiagnostics(uri, model).map(d => d.code)).toEqual([]);
    expect(computeDocumentLinks(uri, model)).toHaveLength(1);
  });
});

describe('L2: passage roles are masked by one helper', () => {
  const widgets: Array<[string, string]> = [[widgetsUri, ':: Widgets [widget]\n{widget "wrap" block}{@children}{/widget}']];
  const body = '{wrap}x{/wrap} [[Target]] {goto "Target"} {$x}';
  const roles: Array<[string, string, string]> = [
    ['script', ':: Code [script]', body],
    ['stylesheet', ':: Style [stylesheet]', body],
    ['StoryTitle', ':: StoryTitle', body],
    ['SaveTitle', ':: SaveTitle', body],
    ['StoryData', ':: StoryData', body],
    ['StoryVariables', ':: StoryVariables', `$x = 1${'\n'}// ${body}`],
    ['StoryTransients', ':: StoryTransients', `%t = 1${'\n'}// ${body}`],
  ];

  for (const [eolName, eol] of eols) {
    for (const [role, header, roleBody] of roles) {
      const text = lines(eol,
        header, ...roleBody.split('\n'),
        ...(role === 'StoryVariables' ? [] : [':: StoryVariables', '$x = 1']),
        ':: Start', '{wrap}real{/wrap} [[Target]]',
        ':: Target', 'end', '');

      it(`L2-${role}: macros and links in the body are not references or rename edits (${eolName})`, () => {
        const model = workspace(text, widgets);
        expect(findWidgetReferences('wrap', model, false)).toHaveLength(2);
        expect(findPassageReferences('Target', model, false)).toHaveLength(1);
        const edits = computeRename(uri, at(text, '{wrap}real', 2), 'box', model);
        const output = apply(text, edits.get(uri));
        expect(output).toContain('{box}real{/box}');
        // Everything before the real passage, role body included, is untouched
        expect(output.slice(0, output.indexOf(':: Start'))).toBe(text.slice(0, text.indexOf(':: Start')));
        // A closer inside the body is not a definition either
        expect(getDefinition(uri, at(text, '{/wrap}', 3), model)).toBeNull();
        expect(prepareRename(uri, at(text, '{/wrap}', 3), model)).toBeNull();
      });

      it(`L2-${role}-diagnostics: the body causes no macro, container or link diagnostic (${eolName})`, () => {
        const model = workspace(text, widgets);
        const found = codes(model);
        for (const code of ['SP100', 'SP101', 'SP104', 'SP300']) expect(found).not.toContain(code);
        // The widget is invoked in Start only
        expect(codes(model, widgetsUri)).not.toContain('SP303');
      });
    }

    it(`L2-widget-use: a widget used only in a non-markup passage is still unused (${eolName})`, () => {
      const text = lines(eol, ':: Code [script]', '{wrap}x{/wrap}', ':: StoryVariables', '$x = 1', ':: Start', 'plain', '');
      const model = workspace(text, widgets);
      expect(codes(model, widgetsUri)).toContain('SP303');
    });

    it(`L2-masking: the helper blanks bodies, keeps line breaks and offsets (${eolName})`, () => {
      const text = lines(eol, ':: Code [script]', 'a {if $x}', ':: Start', 'b', '');
      const model = workspace(text);
      const masked = maskNonMarkupPassages(text, model.passages.getPassagesInDocument(uri));
      expect(masked.length).toBe(text.length);
      expect(masked).toBe(lines(eol, ':: Code [script]', '         ', ':: Start', 'b', ''));
    });

    it(`C-L2: markup passages keep their macros (${eolName})`, () => {
      const markup = ['StoryInit', 'StoryInterface', 'StoryCaption', 'PassageHeader', 'Other'];
      for (const name of markup) {
        const text = lines(eol, ':: StoryVariables', '$x = 1', `:: ${name}`, '{wrap}x{/wrap}', ':: Start', 'plain', '');
        const model = workspace(text, widgets);
        expect(findWidgetReferences('wrap', model, false), name).toHaveLength(2);
      }
    });

    it(`L2-folding: a container in a non-markup passage does not fold (${eolName})`, () => {
      const text = lines(eol, ':: Style [stylesheet]', '{if $x}', 'a', '{/if}', ':: StoryVariables', '$x = 1', ':: Start', '{if $x}', 'a', '{/if}', '');
      const model = workspace(text);
      const folds = computeFoldingRanges(uri, model).filter(f => f.kind !== 'region');
      expect(folds.map(f => f.startLine)).toEqual([7]);
    });
  }
});

describe('L4: crossed containers', () => {
  const block = (names: string[]): Array<[string, string]> => [[
    widgetsUri,
    `:: Widgets [widget]\n${names.map(n => `{widget "${n}" block}{@children}{/widget}`).join('\n')}`,
  ]];

  for (const [eolName, eol] of eols) {
    it(`L4-rename: the closer of a crossed widget stays with it (${eolName})`, () => {
      const text = lines(eol, ':: StoryVariables', '$x = 1', ':: Start', '{wrap}{if $x}{/wrap}{/if}', '');
      const model = workspace(text, block(['wrap']));
      expect(findWidgetReferences('wrap', model, false)).toHaveLength(2);
      const edits = computeRename(uri, at(text, '{wrap}', 2), 'box', model);
      expect(apply(text, edits.get(uri))).toContain('{box}{if $x}{/box}{/if}');
      expect(getDefinition(uri, at(text, '{/wrap}', 3), model)).not.toBeNull();
    });

    it(`L4-two-widgets: each crossed closer renames with its own widget (${eolName})`, () => {
      const text = lines(eol, ':: StoryVariables', '$x = 1', ':: Start', '{outer}{inner}{/outer}{/inner}', '');
      const model = workspace(text, block(['outer', 'inner']));
      const edits = computeRename(uri, at(text, '{inner}', 2), 'core', model);
      expect(apply(text, edits.get(uri))).toContain('{outer}{core}{/outer}{/core}');
      const after = workspace(apply(text, edits.get(uri)), block(['outer', 'core']).map(([u, t]) => [u, t.replace('"inner"', '"core"')] as [string, string]));
      expect(findWidgetReferences('core', after, false)).toHaveLength(2);
    });

    it(`C-L4: a closer with no open container of its name is still no widget reference (${eolName})`, () => {
      const text = lines(eol, ':: StoryVariables', '$x = 1', ':: Start', '{if $x}{/wrap}{/if}', '');
      const model = workspace(text, block(['wrap']));
      expect(findWidgetReferences('wrap', model, false)).toEqual([]);
      expect(prepareRename(uri, at(text, '{/wrap}', 3), model)).toBeNull();
    });

    it(`L4-diagnostics: SP101 names the closer Spindle rejects (${eolName})`, () => {
      const text = lines(eol, ':: StoryVariables', '$x = 1', ':: Start', '{wrap}{if $x}{/wrap}{/if}', '');
      const model = workspace(text, block(['wrap']));
      const messages = computeDiagnostics(uri, model).filter(d => d.code === 'SP101').map(d => d.message);
      expect(messages).toContain('Malformed container: expected {/if} but found {/wrap}');
      expect(messages).toContain('Malformed container: no matching {/wrap}');
      expect(messages).toHaveLength(2);
    });
  }
});
