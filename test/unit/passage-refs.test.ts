/**
 * The passage names written out in a document (core/markup/passage-refs.ts):
 * what `passagePieces` reports as a name, with the exact characters of each as
 * written (inside the quotes of a quoted name), in every spelling.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { documentPassageRefs, passageRefAt, documentRefsNamed } from '../../src/core/markup/passage-refs.js';

const uri = 'file:///story.tw';
const models: WorkspaceModel[] = [];
afterEach(() => { for (const model of models.splice(0)) model.dispose(); });

function read(text: string) {
  const model = new WorkspaceModel();
  model.initialize(new Map([[uri, text]]));
  models.push(model);
  const doc = model.markup.get(uri)!;
  const document = TextDocument.create(uri, 'twee', 0, text);
  const refs = documentPassageRefs(doc);
  return {
    doc,
    refs,
    /** [name, form, written text] of each reference */
    summary: refs.map(ref => [ref.name, ref.form, document.getText(ref.range)] as const),
  };
}

describe('passage references: spellings', () => {
  it('reads bracket links in all four forms, with the target as written', () => {
    const { summary } = read(':: Start\n[[A]] [[x|B]] [[x->C]] [[D<-x]] [[.k#i x->E]] [[ x | F ]]');
    expect(summary).toEqual([
      ['A', 'bracket', 'A'], ['B', 'bracket', 'B'], ['C', 'bracket', 'C'], ['D', 'bracket', 'D'],
      ['E', 'bracket', 'E'], ['F', 'bracket', 'F'],
    ]);
  });

  it('reads the quoted passage of goto, include and link, and the goto of watch', () => {
    const { summary, refs } = read([
      ':: Start',
      '{goto "A"}',
      "{include 'B' inline}",
      '{link "label" "C"}{/link}',
      '{watch "$x > 1" goto "D"}',
      '{.k#i goto "E"}',
    ].join('\n'));
    expect(summary).toEqual([
      ['A', 'quoted', 'A'], ['B', 'quoted', 'B'], ['C', 'quoted', 'C'], ['D', 'quoted', 'D'], ['E', 'quoted', 'E'],
    ]);
    expect(refs.map(ref => [ref.macro, ref.quote])).toEqual([
      ['goto', '"'], ['include', "'"], ['link', '"'], ['watch', '"'], ['goto', '"'],
    ]);
  });

  it('reads the body of {dialog} as text', () => {
    const { summary } = read(':: Start\n{dialog "Title"}  Name here  {/dialog}');
    expect(summary).toEqual([['Name here', 'text', 'Name here']]);
  });

  it('reads a quoted name as its JavaScript value and keeps the written escapes in the range', () => {
    const { summary } = read(':: Start\n{goto "\\u004eext"} {goto "a\\"b"} {goto \'it\\\'s\'}');
    expect(summary).toEqual([
      ['Next', 'quoted', '\\u004eext'], ['a"b', 'quoted', 'a\\"b'], ["it's", 'quoted', "it\\'s"],
    ]);
  });

  it('reads no name from an expression: a bare word, a template literal, a variable, a concatenation', () => {
    const { refs } = read(':: Start\n{goto Next} {goto `Next`} {goto $to} {include _p} {goto "a" + "b"} {link "go" Next}x{/link}');
    expect(refs).toEqual([]);
  });

  it('skips a link with an empty target', () => {
    expect(read(':: Start\n[[go->]] [[ ]] [[]]').refs).toEqual([]);
  });

  it('reads nothing in a closed HTML comment, a script or a data passage', () => {
    const { refs } = read([
      ':: Start',
      '<!-- [[A]] {goto "B"} -->',
      ':: Code [script]',
      'const s = "[[C]]";',
      ':: StoryData',
      '{"ifid": "[[D]]"}',
    ].join('\n'));
    expect(refs).toEqual([]);
  });
});

describe('passage references: labels and attribute values hold markup', () => {
  it('reads a name in the label of a link, a button and an HTML attribute', () => {
    const { summary } = read([
      ':: Start',
      '[[{goto "A"}->T]]',
      '{button "Go {goto \'B\'}"}{goto "C"}{/button}',
      '<a title="{goto \'D\'}">x</a>',
    ].join('\n'));
    expect(summary).toEqual([
      ['T', 'bracket', 'T'], ['A', 'quoted', 'A'], ['B', 'quoted', 'B'], ['C', 'quoted', 'C'], ['D', 'quoted', 'D'],
    ]);
  });

  it('puts the range on the name inside a label written with escaped quotes', () => {
    const text = ':: Start\n{button "Go {goto \\"Q\\"} now"}x{/button}';
    const { refs } = read(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ name: 'Q', form: 'quoted', quote: '"' });
    expect(TextDocument.create(uri, 'twee', 0, text).getText(refs[0].range)).toBe('Q');
    expect(refs[0].within).toEqual({ quote: '"', attribute: false });
  });
});

describe('passage references: positions', () => {
  for (const [eolName, eol] of [['LF', '\n'], ['CRLF', '\r\n']] as const) {
    it(`maps ranges to the document, past astral characters and line breaks (${eolName})`, () => {
      const text = [':: Start', '\u{1F600} [[Go->A]]', '{goto', '  "B"}', ':: A', 'x'].join(eol);
      const { refs, summary } = read(text);
      expect(summary).toEqual([['A', 'bracket', 'A'], ['B', 'quoted', 'B']]);
      // UTF-16 columns: the astral character is two units
      expect(refs[0].range.start).toEqual({ line: 1, character: 9 });
      expect(refs[1].range.start).toEqual({ line: 3, character: 3 });
    });
  }

  it('finds the reference at a position, the end of the name included', () => {
    const { doc } = read(':: Start\n[[Go->Target]] {goto "Other"}');
    expect(passageRefAt(doc, { line: 1, character: 6 })?.name).toBe('Target');
    expect(passageRefAt(doc, { line: 1, character: 12 })?.name).toBe('Target');
    expect(passageRefAt(doc, { line: 1, character: 3 })).toBeUndefined();
    expect(passageRefAt(doc, { line: 1, character: 22 })?.name).toBe('Other');
    expect(passageRefAt(doc, { line: 0, character: 4 })).toBeUndefined();
  });

  it('indexes the references by name', () => {
    const { doc } = read(':: Start\n[[A]] [[B]] {goto "A"}');
    expect(documentRefsNamed(doc, 'A')).toHaveLength(2);
    expect(documentRefsNamed(doc, 'B')).toHaveLength(1);
    expect(documentRefsNamed(doc, 'C')).toEqual([]);
  });
});
