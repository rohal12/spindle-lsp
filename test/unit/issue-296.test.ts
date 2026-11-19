import { afterEach, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { pieceOffset, type Piece } from '@rohal12/spindle/tooling';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { sourceView, textAt, viewIndex } from '../../src/core/markup/source-view.js';
import { computeRename } from '../../src/plugins/rename.js';
import { computeInlayHints } from '../../src/plugins/inlay-hints.js';
import type { PassageMarkup } from '../../src/core/markup/passage-markup.js';

const uri = 'file:///story.tw';
const models: WorkspaceModel[] = [];
afterEach(() => { for (const model of models.splice(0)) model.dispose(); });
function workspace(text: string) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text], ['file:///widgets.tw', ':: Widgets [widget]\n{widget "show" @value}{@value}{/widget}']]));
  return model;
}

/** Count actual ownership input reads, independent of the chosen index structure. */
function countReads(passage: PassageMarkup) {
  let reads = 0;
  const pieces = passage.pieces.map(piece => new Proxy(piece, {
    get(target, key, receiver) {
      if (key === 'offset') reads++;
      return Reflect.get(target, key, receiver);
    },
  }));
  Object.defineProperty(passage, 'pieces', { value: pieces });
  return { pieces, reads: () => reads };
}

it.each([64, 128])('bounds ownership reads for repeated rename and inlay requests with %i calls (#296)', count => {
  const body = Array.from({ length: count }, () => '[[{show $x}->Start]] {print $x}').join('\n');
  const original = ':: StoryVariables\n$x = 1\n:: Start\n' + body;
  const model = workspace(original);
  for (const text of [original, original.replaceAll('->Start', 'text->Start')]) {
    model.documents.update(uri, text);
    const passage = model.markup.get(uri)!.passages.at(-1)!;
    const counter = countReads(passage);
    for (let request = 0; request < 2; request++) {
      const edits = computeRename(uri, { line: 1, character: 1 }, 'renamed', model).get(uri)!;
      expect(edits).toHaveLength(count * 2 + 1);
      const edited = TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, text), edits);
      expect(edited).toBe(text.replaceAll('$x', '$renamed'));
      const hints = computeInlayHints(uri, { start: { line: 0, character: 0 }, end: { line: count + 5, character: 0 } }, model)
        .filter(hint => hint.kind === 'parameter');
      expect(hints).toHaveLength(count);
      expect(hints.every(hint => hint.label === '@value:' && hint.position.character === 8)).toBe(true);
    }
    expect(counter.reads()).toBeLessThan(counter.pieces.length * 16 + count * 16);
  }
});

it.each(['\n', '\r\n', '\r'])('retains decoded nested owners, mappings and fallbacks with %j line breaks (#296)', eol => {
  const body = String.raw`<span title='{button "say \"hi\" {show $x.foo}{print $x.foo}"}x{/button}'>x</span>`;
  const text = [':: StoryVariables', '$x = {}', ':: Start', body, '{print $x.foo}', 'plain'].join(eol);
  const model = workspace(text);
  const passage = model.markup.get(uri)!.passages.at(-1)!;
  const start = passage.content.indexOf('$x.foo');
  const end = start + '$x.foo'.length;
  const label = textAt(passage, start, end)!;
  const code = sourceView(passage, start, end);
  expect(label.text).toBe('say "hi" {show $x.foo}{print $x.foo}');
  expect(label.sourceOffsets).toBeDefined();
  expect(code).toBe(label);
  const nestedCode = passage.content.indexOf('$x.foo', end);
  expect(sourceView(passage, nestedCode, nestedCode + 6).text).toBe('$x.foo');
  expect(pieceOffset(code, viewIndex(code, end))).toBe(end);
  expect(passage.range(start, end)).toEqual({ start: { line: 3, character: 39 }, end: { line: 3, character: 45 } });
  const hints = computeInlayHints(uri, { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } }, model);
  expect(hints.filter(hint => hint.kind === 'parameter')).toEqual([
    { label: '@value:', kind: 'parameter', position: { line: 3, character: 39 } },
  ]);
  const plain = passage.content.indexOf('plain');
  expect(textAt(passage, plain, plain + 5)).toBeUndefined();
  expect(sourceView(passage, plain, plain + 5)).toEqual({ offset: 0, text: passage.content });
  const direct = passage.content.lastIndexOf('$x.foo');
  expect(textAt(passage, direct, direct + 6)).toBeUndefined();
  expect(sourceView(passage, direct, direct + 6).text).toBe('$x.foo');
});

it('retains the last containing tooling piece for overlapping, equal and empty spans (#296)', () => {
  const passage = workspace(':: Start\n' + 'x'.repeat(60)).markup.get(uri)!.passages[0];
  const text = (offset: number, length: number): Piece => ({ kind: 'text', offset, text: 't'.repeat(length), where: '', tokens: [], errors: [] });
  const pieces: Piece[] = [text(0, 40), text(5, 15), text(10, 25),
    { kind: 'code', offset: 10, code: 'c'.repeat(25), label: '', goal: 'expression' },
    text(10, 0), text(40, 5), text(30, 10)];
  Object.defineProperty(passage, 'pieces', { value: pieces });
  for (const [start, end, owner, textOwner] of [
    [10, 10, 4, 4], [10, 11, 3, 2], [20, 30, 3, 2], [30, 35, 6, 6],
    [0, 40, 0, 0], [40, 40, 6, 6], [40, 41, 5, 5], [45, 45, 5, 5], [46, 46, -1, -1],
  ]) {
    const expected = pieces[owner];
    expect(sourceView(passage, start, end).text, `${start}:${end}`).toBe(expected?.kind === 'code' ? expected.code : expected?.kind === 'text' ? expected.text : passage.content);
    expect(textAt(passage, start, end), `${start}:${end}`).toBe(pieces[textOwner]);
  }
});

it('matches the original containment oracle for unsorted decoded and overlapping pieces (#296)', () => {
  const passage = workspace(':: Start\n' + 'x'.repeat(30)).markup.get(uri)!.passages[0];
  const pieces: Piece[] = [
    { kind: 'text', offset: 3, text: 'abc', sourceOffsets: [3, 6, 9, 12], where: '', tokens: [], errors: [] },
    { kind: 'code', offset: 0, code: 'abcdefghijklmnopqrst', label: '', goal: 'expression' },
    { kind: 'text', offset: 6, text: 'xy', sourceOffsets: [6, 11, 16], where: '', tokens: [], errors: [] },
    { kind: 'code', offset: 2, code: 'xy', sourceOffsets: [2, 5, 14], label: '', goal: 'expression' },
    { kind: 'text', offset: 6, text: '', where: '', tokens: [], errors: [] },
  ];
  Object.defineProperty(passage, 'pieces', { value: pieces });
  for (let start = 0; start <= 21; start++) {
    for (let end = start; end <= 21; end++) {
      const owners = pieces.filter(piece => {
        const value = piece.kind === 'text' ? piece.text : piece.kind === 'code' ? piece.code : undefined;
        return value !== undefined && piece.offset <= start && pieceOffset(piece, value.length) >= end;
      });
      const owner = owners.at(-1);
      const expected = owner?.kind === 'code' ? { ...owner, text: owner.code }
        : owner ?? { offset: 0, text: passage.content };
      expect(sourceView(passage, start, end), `${start}:${end}`).toEqual(expected);
      expect(textAt(passage, start, end), `${start}:${end}`).toBe(owners.filter(piece => piece.kind === 'text').at(-1));
    }
  }
});
