import { afterEach, describe, expect, it } from 'vitest';
import { parseTwee } from '@rohal12/twee-ts';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { computeRename } from '../../src/plugins/rename.js';
import { formatDocument } from '../../src/plugins/format.js';
import { splitPassages } from '../../src/plugins/format/segment.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'file:///issue-159.twee';
const declaration = '$declared = "a long declaration payload with spaces"';
const lines = [
  ':: Before',
  'before',
  ':: StoryVariables {"position":}',
  declaration,
  ':: Target [nobr] {"position":}',
  'target',
  ':: Widgets [widget] {"position":}',
  '{widget greet}Hello{/widget}',
  ':: Start',
  '[[Target]] {$declared} {greet}',
];
const names = ['Before', 'StoryVariables', 'Target', 'Widgets', 'Start'];
const tags = [[], [], ['nobr'], ['widget'], []];
const workspaces: WorkspaceModel[] = [];
afterEach(() => { for (const workspace of workspaces.splice(0)) workspace.dispose(); });

function workspace(text: string): WorkspaceModel {
  const model = new WorkspaceModel();
  workspaces.push(model);
  model.initialize(new Map([[uri, text]]));
  return model;
}

describe.each(['\n', '\r\n'])('invalid delimited metadata with %j line endings (#159)', eol => {
  const text = lines.join(eol) + eol;

  it('keeps compiler passage boundaries, tags and declarations', () => {
    const compiled = parseTwee(text);
    expect(compiled.passages.map(passage => passage.name)).toEqual(names);
    expect(compiled.passages.map(passage => passage.tags)).toEqual(tags);
    expect(compiled.diagnostics.map(diagnostic => diagnostic.level)).toEqual(['warning', 'warning', 'warning']);
    const model = workspace(text);
    const passages = model.passages.getPassagesInDocument(uri);
    expect(passages.map(passage => passage.name)).toEqual(names);
    expect(passages.map(passage => passage.tags ?? [])).toEqual(tags);
    expect(passages.map(passage => passage.range.start.line)).toEqual([0, 2, 4, 6, 8]);
    expect(passages.slice(0, -1).map(passage => passage.range.end.line)).toEqual([1, 3, 5, 7]);
    expect(model.variables.getDeclared().has('declared')).toBe(true);
    expect(model.widgets.getWidget('greet')).toMatchObject({ uri, range: { start: { line: 7, character: 0 } } });
    expect(computeDiagnostics(uri, model)).toEqual([]);
  });

  it('navigates and renames the passage while retaining its tags and invalid metadata', () => {
    const model = workspace(text);
    const document = TextDocument.create(uri, 'twee', 1, text);
    const reference = document.positionAt(text.indexOf('[[Target]]') + 3);
    expect(getDefinition(uri, reference, model)).toMatchObject({
      uri, range: { start: { line: 4, character: 0 }, end: { line: 4, character: lines[4].length } },
    });
    const edits = computeRename(uri, { line: 4, character: 4 }, 'Renamed', model);
    const renamed = TextDocument.applyEdits(document, edits.get(uri) ?? []);
    expect(renamed).toBe(text.replace(':: Target', ':: Renamed').replace('[[Target]]', '[[Renamed]]'));
    expect(parseTwee(renamed).passages.map(passage => passage.name)).toEqual(['Before', 'StoryVariables', 'Renamed', 'Widgets', 'Start']);
  });

  it('formats each body with its own passage role and preserves metadata warnings', async () => {
    expect(splitPassages(text).map(passage => passage.startLine)).toEqual([0, 2, 4, 6, 8]);
    const formatted = await formatDocument(text, { maxLineLength: 20 });
    expect(formatted).toContain(`:: StoryVariables {"position":}${eol}${declaration}${eol}`);
    expect(formatted).toContain(`:: Target [nobr] {"position":}${eol}`);
    expect(formatted).toContain(`:: Widgets [widget] {"position":}${eol}`);
    const compiled = parseTwee(formatted);
    expect(compiled.passages.map(passage => passage.name)).toEqual(names);
    expect(compiled.passages.map(passage => passage.tags)).toEqual(tags);
    expect(compiled.diagnostics.map(diagnostic => diagnostic.level)).toEqual(['warning', 'warning', 'warning']);
    expect(await formatDocument(formatted, { maxLineLength: 20 })).toBe(formatted);
  });
});

it('does not merge malformed StoryVariables metadata into StoryData (#159)', () => {
  const model = workspace(':: StoryData\n{"format":"Spindle"}\n:: StoryVariables {"position":}\n$x = 1\n:: Start\nValue: {$x}\n');
  expect(model.storyFormat).toBe('Spindle');
  expect(model.variables.getDeclared().has('x')).toBe(true);
  expect(computeDiagnostics(uri, model)).toEqual([]);
});
