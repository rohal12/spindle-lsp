/**
 * Contracts of the diagnostics assembled from Spindle's tooling API: they are
 * computed for the whole story and kept until a document changes, a malformed
 * passage does not hide the rest of it, and positions are right in CRLF
 * documents and past astral characters.
 */
import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'file:///story.tw';

function workspace(text: string, extra: Array<[string, string]> = []): WorkspaceModel {
  const model = new WorkspaceModel();
  model.initialize(new Map([...extra, [uri, text]]));
  return model;
}

const codes = (model: WorkspaceModel, u = uri) => computeDiagnostics(u, model).map(d => d.code);

describe('diagnostics follow the story', () => {
  it('are recomputed when a document changes, in this document and in the others', () => {
    const model = workspace(':: Start\n[[Next]]\n', [['file:///next.tw', ':: Next\nhi\n']]);
    expect(codes(model)).toEqual([]);
    // removing the passage a link names breaks the link; the document that held it has no diagnostics of its own
    model.documents.update('file:///next.tw', ':: Elsewhere\nhi\n');
    expect(codes(model)).toEqual(['SP300']);
    expect(codes(model, 'file:///next.tw')).toEqual([]);
    model.documents.update('file:///next.tw', ':: Next\nhi\n');
    expect(codes(model)).toEqual([]);
    model.documents.update(uri, ':: Start\n{nope}\n');
    expect(codes(model)).toEqual(['SP100']);
  });

  it('follow a widget defined, renamed or removed in another document', () => {
    const model = workspace(':: Start\n{greet "x"}\n', [['file:///w.tw', ':: W [widget]\n{widget "greet" @who}hi {@who}{/widget}\n']]);
    expect(codes(model)).toEqual([]);
    model.documents.update('file:///w.tw', ':: W [widget]\n{widget "greet"}hi{/widget}\n');
    expect(codes(model)).toEqual(['SP301']);
    model.documents.update('file:///w.tw', ':: W [widget]\n{widget "welcome"}hi{/widget}\n');
    expect(codes(model)).toEqual(['SP100']);
  });

  it('follow the declarations of StoryVariables', () => {
    const model = workspace(':: Start\n{print $gold}\n', [['file:///vars.tw', ':: StoryVariables\n$health = 1\n']]);
    expect(computeDiagnostics(uri, model).map(d => [d.code, d.message])).toEqual([['SP200', 'Undeclared variable: $gold']]);
    model.documents.update('file:///vars.tw', ':: StoryVariables\n$health = 1\n$gold = 0\n');
    expect(codes(model)).toEqual([]);
    model.documents.update('file:///vars.tw', ':: StoryVariables\n$gold = "rich"\n');
    expect(codes(model)).toEqual([]);
    model.documents.update(uri, ':: Start\n{print $gold.nope}\n');
    expect(computeDiagnostics(uri, model).map(d => d.code)).toEqual(['SP201']);
  });
});

describe('a malformed passage does not hide the rest of it', () => {
  it('reports unknown macros, broken links and code errors beside an unclosed block and an unclosed link', () => {
    const model = workspace(':: StoryVariables\n$x = 1\n\n:: Start\n{if $x}\n{nope}\n[[Nowhere]]\n{set $x = }\n[[open');
    const found = computeDiagnostics(uri, model).map(d => [d.code, d.range.start.line]);
    expect(found).toEqual([
      ['SP101', 4],
      ['SP100', 5],
      ['SP300', 6],
      ['SP106', 7],
      ['SP105', 8],
    ]);
  });

  it('reads every passage on its own', () => {
    const model = workspace(':: A\n{if true}\n:: B\n{nope}\n:: C\n[[Nowhere]]\n');
    expect(computeDiagnostics(uri, model).map(d => [d.code, d.range.start.line])).toEqual([
      ['SP101', 1],
      ['SP100', 3],
      ['SP300', 5],
    ]);
  });
});

describe('diagnostic positions', () => {
  const story = ':: StoryVariables\n$x = 1\n:: Start\n\u{1F600}{nope} [[Nowhere]]\n{set $x = }\n<div>\n';

  it('are the same in a CRLF document as in a LF one', () => {
    const lf = computeDiagnostics(uri, workspace(story)).map(d => [d.code, d.range]);
    const crlf = computeDiagnostics(uri, workspace(story.replace(/\n/g, '\r\n'))).map(d => [d.code, d.range]);
    expect(lf.map(([code]) => code)).toEqual(['SP100', 'SP300', 'SP106', 'SP102']);
    expect(crlf).toEqual(lf);
  });

  it('count UTF-16 code units, and cover the text they name', () => {
    const doc = TextDocument.create(uri, 'twee', 0, story);
    const found = computeDiagnostics(uri, workspace(story));
    const covered = found.map(d => [d.code, doc.getText(d.range)]);
    expect(covered).toEqual([
      ['SP100', '{nope}'],
      ['SP300', 'Nowhere'],
      ['SP106', '='],
      ['SP102', '<div>'],
    ]);
    // the emoji is two code units
    expect(found[0].range.start).toEqual({ line: 3, character: 2 });
  });
});

describe('what a quick fix needs travels with the diagnostic', () => {
  it('names the macro, its closest known macros and where the name is written', () => {
    const [sp100] = computeDiagnostics(uri, workspace(':: StoryVariables\n$x = 1\n:: Start\n{.cls sett $x = 2}'));
    expect(sp100.data).toEqual({
      kind: 'unknown-macro',
      name: 'sett',
      suggestions: ['set'],
      nameRange: { start: { line: 3, character: 6 }, end: { line: 3, character: 10 } },
    });
  });

  it('names the passage and the macro it is the argument of', () => {
    const [sp300] = computeDiagnostics(uri, workspace(':: Start\n{goto "Hal"}\n:: Hall\nx\n'));
    expect(sp300.data).toEqual({ kind: 'unknown-passage', name: 'Hal', macro: 'goto', suggestions: ['Hall'] });
  });
});
