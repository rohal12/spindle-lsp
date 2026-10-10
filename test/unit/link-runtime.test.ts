/**
 * Link text the runtime reads differently (SP304, #P-observed item 1).
 *
 * Oracle: the installed Spindle, through its public tooling API. A bracket
 * link is a token; the AST turns it into `{link "label" "target"}` (both
 * quoted, `\` and `"` escaped); the macro reads its arguments as its
 * parameters declare (`passagePieces`: the `text` is a quoted string holding
 * markup, the `passage` a quoted name read as a JavaScript literal, else an
 * expression, test/helpers/link-macro-oracle.ts). The tests compare that with
 * what spindle-lsp reports. Spindle 0.59 no longer collects quoted parts with
 * a regular expression, so a quote or backslash in a label or target is
 * carried; what the quoting cannot carry is a line break in the target (a raw
 * newline ends a JavaScript string literal, so the macro reads an expression
 * and the click fails).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { findPassageReferences } from '../../src/plugins/references.js';
import { computeRename, encodePassageRefName, RenameError } from '../../src/plugins/rename.js';
import { findLinkRuntimeMismatches } from '../../src/core/parsing/link-parser.js';
import { readBracketLink } from '../../src/core/parsing/link-runtime.js';
import { documentPassageRefs } from '../../src/core/markup/passage-refs.js';
import { tokenize } from '../helpers/tooling.js';
import { runtimeBracketLink, runtimeLinkMacro } from '../helpers/link-macro-oracle.js';
import { DiagnosticCode } from '../../src/core/diagnostic-codes.js';

const eols = [['LF', '\n'], ['CRLF', '\r\n']] as const;

const models: WorkspaceModel[] = [];
afterEach(() => { for (const m of models.splice(0)) m.dispose(); });

const uri = 'file:///story.tw';
function workspace(text: string, extra: Array<[string, string]> = []) {
  const model = new WorkspaceModel({ workspaceRoot: process.cwd() });
  model.initialize(new Map([...extra, [uri, text]]));
  models.push(model);
  return model;
}
const sp304 = (model: WorkspaceModel) => computeDiagnostics(uri, model).filter(d => d.code === DiagnosticCode.LinkRuntimeMismatch);
const textAt = (text: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }) =>
  TextDocument.create(uri, 'twee', 0, text).getText(range as never);
const lf = (text: string) => text.replace(/\r\n/g, '\n');

describe('P1 differential: the link macro reads a bracket link back as spindle-lsp predicts', () => {
  // Pieces of display/target text: quotes of both kinds, a backslash, line
  // breaks of both kinds, spaces and ordinary text
  const pieces = ['a', ' ', '"', "'", '\\', '\n', '\r\n', '{goto "X"}'];

  function* texts(maxLength: number): Generator<string> {
    let level: string[][] = [[]];
    for (let length = 1; length <= maxLength; length++) {
      level = level.flatMap(prefix => pieces.map(piece => [...prefix, piece]));
      for (const parts of level) yield parts.join('');
    }
  }

  it('P1-bracket: every short display and target (|, -> and <- forms)', () => {
    const displays = [...texts(3)];
    const targets = ['T', 'a"b', 'a\nb', "a'b", 'a\\b', ' x ', '"'];
    let checked = 0;
    let mismatched = 0;
    for (const display of displays) {
      for (const target of targets) {
        for (const text of [`[[${display}->${target}]]`, `[[${display}|${target}]]`, `[[${target}<-${display}]]`]) {
          const real = runtimeBracketLink(text);
          if (!real) continue;
          const found = findLinkRuntimeMismatches(text);
          const differs = real.display !== real.token.display || real.passage !== real.token.target;
          expect(found.length, JSON.stringify(text)).toBe(differs ? 1 : 0);
          if (differs) {
            // The reading it reports is the runtime's, and it names the tokenizer's text
            expect(found[0].runtime, JSON.stringify(text)).toEqual({ display: lf(real.display), passage: real.passage });
            expect({ display: found[0].display, target: found[0].target }, JSON.stringify(text))
              .toEqual({ display: lf(real.token.display), target: lf(real.token.target) });
            mismatched++;
          }
          // what the contract says: a line break in the target is the one thing the quoting cannot carry
          expect(differs, JSON.stringify(text)).toBe(/\n/.test(real.token.target));
          expect(readBracketLink(real.token.display, real.token.target), JSON.stringify(text))
            .toEqual({ display: real.display, passage: real.passage });
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10000);
    expect(mismatched).toBeGreaterThan(100);
  });

  it('P1-plain: [[Text]] links and a selector prefix read as the tokenizer does', () => {
    for (const text of ['[[He said "hi"]]', '[[Plain]]', '[[.cls#id He said "hi"->T]]', '[[a\nb]]']) {
      const real = runtimeBracketLink(text)!;
      const differs = real.display !== real.token.display || real.passage !== real.token.target;
      expect(findLinkRuntimeMismatches(text).length, text).toBe(differs ? 1 : 0);
    }
  });

  it('P1-macro: {link} string arguments read as JavaScript strings: nothing to report, and the name is the literal value', () => {
    const strings = ['a', 'a b', 'say \\"hi\\"', "it\\'s", 'a\\\\b', 'a\\nb', "it's", 'q"q', '\\u0054'];
    let compared = 0;
    for (const quote of ['"', "'"]) {
      for (const label of strings) {
        for (const passage of strings) {
          const args = `${quote}${label}${quote} ${quote}${passage}${quote}`;
          const text = `{link ${args}}x{/link}`;
          const macro = tokenize(text).find(t => t.type === 'macro');
          if (!macro || macro.type !== 'macro' || macro.rawArgs !== args) continue;
          const real = runtimeLinkMacro(args);
          let meaning: string | undefined;
          try {
            new Function(`return ${quote}${label}${quote}`)();
            meaning = new Function(`return ${quote}${passage}${quote}`)() as string;
          } catch {
            // a string that is no JavaScript literal (or a label the macro cannot read): no name
            meaning = undefined;
          }
          // the reference spindle-lsp navigates by is the runtime's, which is the JavaScript meaning
          const refs = documentPassageRefs(workspace(`:: Start\n${text}`).markup.get(uri)!);
          if (meaning !== undefined) {
            expect(real.passage, text).toBe(meaning);
            expect(refs.map(r => r.name), text).toEqual([meaning]);
          } else {
            expect(refs, text).toEqual([]);
          }
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(50);
  });
});

describe('P1 SP304 diagnostics', () => {
  for (const [eolName, eol] of eols) {
    const wrap = (body: string) => `:: StoryVariables\n:: T\nx\n:: Start\n${body}`.replace(/\n/g, eol);

    it(`P1-line-break-target (${eolName}): a target that spans lines is read as an expression and navigates nowhere`, () => {
      const text = wrap('[[Go->first line\nsecond line]]');
      const found = sp304(workspace(text));
      expect(found).toHaveLength(1);
      expect(found[0].code).toBe('SP304');
      expect(found[0].severity).toBe('warning');
      expect(textAt(text, found[0].range)).toBe(`[[Go->first line${eol}second line]]`);
      expect(found[0].message).toContain('navigates nowhere');
    });

    it(`P1-multiline-whole (${eolName}): [[a line break]] without a label is its own target`, () => {
      const text = wrap('[[first line\nsecond line]]');
      const found = sp304(workspace(text));
      expect(found).toHaveLength(1);
      expect(textAt(text, found[0].range)).toBe(`[[first line${eol}second line]]`);
    });

    it(`P1-carried (${eolName}): quotes, markup in the label and a label that spans lines read back, nothing is reported`, () => {
      for (const body of ['[[He said "hi"->T]]', '[[{goto "X"}->Target]]', '[[a\nb->T]]', '[[Go->a"b]]', '{link "say \\"hi\\"" "T"}x{/link}']) {
        expect(sp304(workspace(wrap(body))), body).toEqual([]);
      }
    });

    it(`C-P1-controls (${eolName}): quote-free links, apostrophes and backslashes are not reported`, () => {
      for (const body of ["[[Don't go->T]]", '[[a\\b->T]]', '[[T]]', '[[Go|T]]', '[[T<-Go]]', '{link "go" "T"}x{/link}', '{print "[[He said \\"hi\\"->T]]"}']) {
        expect(sp304(workspace(wrap(body))), body).toEqual([]);
      }
    });

    it(`P1-macro-escape-n (${eolName}): \\n in a {link} string is a line break in the name, as in any JavaScript string`, () => {
      const model = workspace(wrap('{link "a\\nb" "T"}x{/link}'));
      expect(sp304(model)).toEqual([]);
    });
  }

  it('P1-masked: script and attribute text holding link syntax is not a link', () => {
    const model = workspace(':: StoryVariables\n:: T\nx\n:: code [script]\nconst a = "[[He said \\"hi\\"->T]]";\n:: Start\n<a title=\'[[say "x"->T]]\'>x</a>');
    expect(sp304(model)).toEqual([]);
  });
});

describe('P1 consumers: navigation follows the written target', () => {
  const text = ':: StoryVariables\n:: T\nx\n:: Start\n[[He said "hi"->T]] {link "go" "T"}x{/link}';

  it('P1-refs: references, definition and passage refs name T', () => {
    const model = workspace(text);
    expect(findPassageReferences('T', model, false)).toHaveLength(2);
    const column = text.split('\n')[4].indexOf('T]]');
    expect(getDefinition(uri, { line: 4, character: column }, model)?.uri).toBe(uri);
    expect(documentPassageRefs(model.markup.get(uri)!).map(r => r.name)).toEqual(['T', 'T']);
  });

  it('P1-link-macro-target: the {link} target is the runtime one: the JavaScript value of the string', () => {
    const args = '"go" "a\\"b"';
    const [ref] = documentPassageRefs(workspace(`:: Start\n{link ${args}}x{/link}`).markup.get(uri)!);
    expect(ref).toMatchObject({ name: 'a"b', form: 'quoted', macro: 'link' });
    expect([ref.range.start.character, ref.range.end.character]).toEqual([12, 16]);
    // and what the installed runtime navigates to
    expect(ref.name).toBe(runtimeLinkMacro(args).passage);
    // a block is part of the name: the macro does not interpolate it
    const [braces] = documentPassageRefs(workspace(':: Start\n{link "go" "{$x}"}x{/link}').markup.get(uri)!);
    expect(braces.name).toBe('{$x}');
    expect(runtimeLinkMacro('"go" "{$x}"').passage).toBe('{$x}');
  });

  it('P1-rename-bracket: a quote can be written in a [[link]]; a line break cannot', () => {
    // (a line break cannot be a passage name: the header check rejects it first, so ask the encoder)
    const story = ':: StoryVariables\n:: Old\nx\n:: Start\n[[Old]]';
    const model = workspace(story);
    const edits = computeRename(uri, { line: 1, character: 5 }, 'Bob"s', model);
    const output = TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, story), edits.get(uri) ?? []);
    expect(output).toBe(':: StoryVariables\n:: Bob"s\nx\n:: Start\n[[Bob"s]]');
    expect(runtimeBracketLink('[[Bob"s]]')?.passage).toBe('Bob"s');
    const [ref] = documentPassageRefs(model.markup.get(uri)!);
    expect(ref.form).toBe('bracket');
    expect(() => encodePassageRefName(ref, 'two\nlines')).toThrow(RenameError);
    expect(() => encodePassageRefName(ref, 'two\nlines')).toThrow(/\[\[link\]\]/);
  });

  it('P1-rename-link-macro: the {link} string is escaped, and the runtime reads the new spelling back as the new name', () => {
    const story = ':: StoryVariables\n:: Old\nx\n:: Start\n{link "go" "Old"}x{/link}';
    const model = workspace(story);
    const edits = computeRename(uri, { line: 1, character: 5 }, 'a"b\\c', model);
    const output = TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, story), edits.get(uri) ?? []);
    expect(output).toContain('{link "go" "a\\"b\\\\c"}');
    expect(runtimeLinkMacro('"go" "a\\"b\\\\c"').passage).toBe('a"b\\c');
    expect(documentPassageRefs(workspace(output).markup.get(uri)!).map(r => r.name)).toEqual(['a"b\\c']);
  });
});
