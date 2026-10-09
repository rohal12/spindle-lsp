/**
 * Passage references and `{do}` bodies (issue #70). From Spindle 0.50.1 the
 * tokenizer keeps a `{do}` body as JavaScript text, so a link- or
 * macro-shaped string in it is no reference: references, definition,
 * prepare/rename, document links and code lenses must not read it, and a
 * rename must leave the literal alone. Before 0.50.1 the body is tokenized
 * like any text and the same string is a real link. The pinned runtime
 * tokenizer is the oracle for the installed side (`INSTALLED_CAPABILITIES`).
 */
import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { tokenize } from '../helpers/tooling.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { findPassageReferences, findReferences } from '../../src/plugins/references.js';
import { computeRename, prepareRename } from '../../src/plugins/rename.js';
import { computeDocumentLinks } from '../../src/plugins/document-link.js';
import { computeCodeLenses } from '../../src/plugins/code-lens.js';
import { INSTALLED_CAPABILITIES } from '../helpers/spindle-version.js';

const uri = 'file:///story.tw';

function story(version: string, body: string): string {
  return `:: StoryData\n{"format":"Spindle","format-version":"${version}"}\n:: StoryVariables\n:: Old\nhi\n:: Start\n${body}\n`;
}
function model(text: string): WorkspaceModel {
  const m = new WorkspaceModel();
  m.initialize(new Map([[uri, text]]));
  return m;
}
function at(text: string, needle: string, nth = 0): { line: number; character: number } {
  let from = -1;
  for (let i = 0; i <= nth; i++) from = text.indexOf(needle, from + 1);
  const before = text.slice(0, from).split('\n');
  return { line: before.length - 1, character: before[before.length - 1].length };
}
function lens(m: WorkspaceModel): string[] {
  return computeCodeLenses(uri, m).map(l => l.command?.title ?? '');
}
function apply(text: string, edits: Map<string, Array<{ range: import('../../src/core/types.js').Range; newText: string }>>): string {
  return TextDocument.applyEdits(TextDocument.create(uri, 'twee', 1, text), edits.get(uri) ?? []);
}
function startBody(text: string): string {
  return text.slice(text.indexOf(':: Start') + 9).replace(/\r\n/g, '\n');
}

const shapes: Array<[string, (t: string) => string]> = [
  ['bracket string', t => `{do}\nconst note = "[[${t}]]";\n{/do}`],
  ['goto string', t => `{do}\nconst n = '{goto "${t}"}';\n{/do}`],
  ['link macro string', t => `{do}\nconst n = '{link "go" "${t}"}';\n{/do}`],
  ['include string', t => `{do}\nconst n = '{include "${t}"}';\n{/do}`],
  ['CRLF body', t => `{do}\r\nconst note = "[[${t}]]";\r\n{/do}`],
  ['inline do', t => `{do}const note = "[[${t}]]";{/do}`],
];

describe('raw {do} bodies are not passage references (0.51.3)', () => {
  for (const [name, make] of shapes) {
    const text = story('0.51.3', make('Old'));

    it(`${name}: no consumer reads a reference`, () => {
      const m = model(text);
      expect(m.capabilities.rawDoBodies).toBe(true);
      expect(findPassageReferences('Old', m, false)).toEqual([]);
      expect(computeDocumentLinks(uri, m)).toEqual([]);
      const missing = computeDiagnostics(uri, model(story('0.51.3', make('Nowhere'))));
      expect(missing.filter(d => d.code === 'SP300')).toEqual([]);
      const p = at(text, 'Old', 1);
      expect(getDefinition(uri, p, m)).toBeNull();
      expect(findReferences(uri, p, m, true)).toEqual([]);
      expect(prepareRename(uri, p, m)).toBeNull();
      expect(computeRename(uri, p, 'New', m).size).toBe(0);
      expect(lens(m)).toContain('0 references');
    });

    it(`${name}: renaming the passage leaves the JavaScript literal unchanged`, () => {
      const m = model(text);
      const edits = computeRename(uri, at(text, 'Old'), 'New', m);
      expect(apply(text, edits)).toBe(text.replace(':: Old\n', ':: New\n'));
    });
  }

  it('the installed tokenizer agrees: a link token only where it is not raw, always for a link outside', () => {
    // peer matrix (0.50.1+): no link token for the string
    const inside = tokenize(startBody(story('0.51.3', '{do}\nconst note = "[[Old]]";\n{/do}')));
    expect(inside.some(t => t.type === 'link')).toBe(!INSTALLED_CAPABILITIES.rawDoBodies);
    const outside = tokenize(startBody(story('0.51.3', '{do}x{/do}\n[[Old]]')));
    expect(outside.some(t => t.type === 'link')).toBe(true);
  });

  it('a real link outside the {do} body is still a reference, and is renamed with the header', () => {
    const text = story('0.51.3', '{do}\nconst note = "[[Old]]";\n{/do}\n[[Old]] {goto "Old"}');
    const m = model(text);
    expect(findPassageReferences('Old', m, false).map(r => r.range.start.line)).toEqual([9, 9]);
    expect(computeDocumentLinks(uri, m)).toHaveLength(1);
    expect(lens(m)).toContain('2 references');
    const edits = computeRename(uri, at(text, 'Old'), 'New', m);
    expect(apply(text, edits)).toBe(
      text.replace(':: Old\n', ':: New\n').replace('[[Old]] {goto "Old"}', '[[New]] {goto "New"}'));
  });

  it('a link after the closing {/do}, and in a {do} with no {/do}, is markup', () => {
    const after = model(story('0.51.3', '{do}x{/do} [[Old]]'));
    expect(findPassageReferences('Old', after, false)).toHaveLength(1);
    expect(computeDocumentLinks(uri, after)).toHaveLength(1);
    const open = model(story('0.51.3', '{do}\n[[Old]]'));
    expect(findPassageReferences('Old', open, false)).toHaveLength(1);
    expect(computeDocumentLinks(uri, open)).toHaveLength(1);
  });
});

describe('{do} bodies before 0.50.1 are tokenized like any text (control)', () => {
  const text = story('0.45.1', '{do}\nconst note = "[[Old]]";\n{/do}');

  it('every consumer reads the link the runtime tokenizes', () => {
    const m = model(text);
    expect(m.capabilities.rawDoBodies).toBe(false);
    expect(findPassageReferences('Old', m, false)).toHaveLength(1);
    expect(computeDocumentLinks(uri, m)).toHaveLength(1);
    const p = at(text, 'Old', 1);
    expect(getDefinition(uri, p, m)).not.toBeNull();
    expect(prepareRename(uri, p, m)).not.toBeNull();
    expect(lens(m)).toContain('1 reference');
  });

  it('the installed runtime decides which side its tokenizer is on', () => {
    const tokens = tokenize('{do}\nconst note = "[[Old]]";\n{/do}');
    expect(tokens.some(t => t.type === 'link')).toBe(!INSTALLED_CAPABILITIES.rawDoBodies);
  });
});
