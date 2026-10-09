/**
 * Link text the runtime reads differently (SP304, #P-observed item 1).
 *
 * Oracle: the installed Spindle. A bracket link is a token, buildAST renders
 * it as `{link}` arguments and MacroLink.parseArgs (the installed
 * component's own function, test/helpers/link-macro-oracle.ts) reads them
 * back; the tests compare that with what spindle-lsp reports. Behavior that
 * depends on the release is exercised for both sides with projects that
 * declare their Spindle version (`project(version)`), the installed runtime
 * checks the matching side for real (scripts/peer-matrix.sh runs the others).
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { findPassageReferences } from '../../src/plugins/references.js';
import { computeRename, RenameError } from '../../src/plugins/rename.js';
import {
  findLinkMacroMismatches,
  findLinkRuntimeMismatches,
  parseDocumentPassageRefs,
  resolveLinkMacroTarget,
} from '../../src/core/parsing/link-parser.js';
import { readBracketLink } from '../../src/core/parsing/link-runtime.js';
import { tokenize } from '../helpers/tooling.js';
import { runtimeBracketLink, runtimeLinkMacro } from '../helpers/link-macro-oracle.js';
import { INSTALLED_CAPABILITIES, INSTALLED_SPINDLE_VERSION } from '../helpers/spindle-version.js';
import { DiagnosticCode } from '../../src/core/diagnostic-codes.js';

const installed = { linkQuoteEscapes: INSTALLED_CAPABILITIES.linkQuoteEscapes };
const eols = [['LF', '\n'], ['CRLF', '\r\n']] as const;

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const models: WorkspaceModel[] = [];
afterEach(() => { for (const m of models.splice(0)) m.dispose(); });

/** A project directory whose installed Spindle is `version`. */
function project(version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'spindle-link-'));
  roots.push(root);
  const pkg = join(root, 'node_modules', '@rohal12', 'spindle');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@rohal12/spindle', version }));
  return root;
}
const uri = 'file:///story.tw';
function workspace(version: string | undefined, text: string, extra: Array<[string, string]> = []) {
  const model = new WorkspaceModel(version ? { workspaceRoot: project(version) } : { workspaceRoot: process.cwd() });
  model.initialize(new Map([...extra, [uri, text]]));
  models.push(model);
  return model;
}
const sp304 = (model: WorkspaceModel) => computeDiagnostics(uri, model).filter(d => d.code === DiagnosticCode.LinkRuntimeMismatch);
const textAt = (text: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }) =>
  TextDocument.create(uri, 'twee', 0, text).getText(range as never);

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
          const found = findLinkRuntimeMismatches(text, installed);
          const differs = real.display !== real.token.display || real.passage !== real.token.target;
          expect(found.length, JSON.stringify(text)).toBe(differs ? 1 : 0);
          if (differs) {
            // The reading it reports is the runtime's, and it names the tokenizer's text
            expect(found[0].runtime, JSON.stringify(text)).toEqual({ display: real.display, passage: real.passage });
            expect({ display: found[0].display, target: found[0].target }, JSON.stringify(text)).toEqual(real.token);
            mismatched++;
          }
          expect(readBracketLink(real.token.display, real.token.target, installed.linkQuoteEscapes), JSON.stringify(text))
            .toEqual({ display: real.display, passage: real.passage });
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10000);
    // before 0.51.1 many of them differ; from 0.51.1 none does
    if (installed.linkQuoteEscapes) expect(mismatched).toBe(0);
    else expect(mismatched).toBeGreaterThan(1000);
  });

  it('P1-plain: [[Text]] links and a selector prefix read as the tokenizer does', () => {
    for (const text of ['[[He said "hi"]]', '[[Plain]]', '[[.cls#id He said "hi"->T]]', '[[a\nb]]']) {
      const real = runtimeBracketLink(text)!;
      const differs = real.display !== real.token.display || real.passage !== real.token.target;
      expect(findLinkRuntimeMismatches(text, installed).length, text).toBe(differs ? 1 : 0);
    }
  });

  it('P1-macro: {link} string arguments, with and without escapes', () => {
    const strings = ['a', 'a b', 'say \\"hi\\"', "it\\'s", 'a\\\\b', 'a\\nb', "it's", 'q"q'];
    let compared = 0;
    for (const quote of ['"', "'"]) {
      for (const label of strings) {
        for (const passage of strings) {
          const args = `${quote}${label}${quote} ${quote}${passage}${quote}`;
          const text = `{link ${args}}x{/link}`;
          const macro = tokenize(text).find(t => t.type === 'macro');
          if (!macro || macro.type !== 'macro' || macro.rawArgs !== args) continue;
          const real = runtimeLinkMacro(args);
          const found = findLinkMacroMismatches(text, installed);
          if (found.length === 0) {
            // no mismatch reported: the runtime reads the JavaScript meaning of both strings
            const js = (s: string) => new Function(`return ${quote}${s}${quote}`)() as string;
            let expected: { display: string; passage: string | null } | undefined;
            try {
              expected = { display: js(label), passage: js(passage) };
            } catch {
              expected = undefined;
            }
            if (expected) expect(real, text).toEqual(expected);
          } else {
            expect(found[0].runtime, text).toEqual(real);
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

    it(`P1-quote-label (${eolName}): [[He said "hi"->T]] before 0.51.1 reads the label as "He said " and navigates nowhere`, () => {
      const text = wrap('[[He said "hi"->T]]');
      const found = sp304(workspace('0.45.1', text));
      expect(found).toHaveLength(1);
      expect(found[0].code).toBe('SP304');
      expect(found[0].severity).toBe('warning');
      expect(textAt(text, found[0].range)).toBe('[[He said "hi"->T]]');
      expect(found[0].message).toContain('0.45.1');
      expect(found[0].message).toContain('navigates nowhere');
      expect(found[0].message).toContain('"T"');
      expect(found[0].message).toContain('0.51.1');
    });

    it(`P1-goto-label (${eolName}): [[{goto "X"}->Target]] navigates to "}" before 0.51.1`, () => {
      const text = wrap('[[{goto "X"}->Target]]');
      const found = sp304(workspace('0.45.1', text));
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('navigates to "}"');
      expect(found[0].message).toContain('"Target"');
      expect(textAt(text, found[0].range)).toBe('[[{goto "X"}->Target]]');
    });

    it(`P1-target-quote (${eolName}): a quote in the target reads the text up to it`, () => {
      const found = sp304(workspace('0.45.1', wrap('[[Go->a"b]]')));
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('navigates to "a"');
    });

    it(`P1-multiline (${eolName}): a label that spans lines navigates nowhere before 0.51.1`, () => {
      const text = wrap('[[first line\nsecond line->T]]');
      const found = sp304(workspace('0.45.1', text));
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('navigates nowhere');
      expect(textAt(text, found[0].range)).toBe(`[[first line${eol}second line->T]]`.replace(/\r?\n/g, eol));
    });

    it(`P1-fixed (${eolName}): from 0.51.1 the same links read back and nothing is reported`, () => {
      for (const body of ['[[He said "hi"->T]]', '[[{goto "X"}->Target]]', '[[a\nb->T]]', '{link "say \\"hi\\"" "T"}x{/link}']) {
        expect(sp304(workspace('0.51.1', wrap(body))), body).toEqual([]);
        expect(sp304(workspace('0.51.3', wrap(body))), body).toEqual([]);
      }
    });

    it(`C-P1-controls (${eolName}): quote-free links, apostrophes and backslashes are not reported`, () => {
      for (const version of ['0.45.1', '0.51.3']) {
        for (const body of ["[[Don't go->T]]", '[[a\\b->T]]', '[[T]]', '[[Go|T]]', '[[T<-Go]]', '{link "go" "T"}x{/link}', '{print "[[He said \\"hi\\"->T]]"}']) {
          expect(sp304(workspace(version, wrap(body))), `${version} ${body}`).toEqual([]);
        }
      }
    });

    it(`P1-macro-escape (${eolName}): {link "say \\"hi\\"" "T"} is read without escapes before 0.51.1`, () => {
      const text = wrap('{link "say \\"hi\\"" "T"}x{/link}');
      const found = sp304(workspace('0.45.1', text));
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('{link}');
      expect(found[0].message).toContain('navigates nowhere');
      expect(textAt(text, found[0].range)).toBe('{link "say \\"hi\\"" "T"}');
    });

    it(`P1-macro-escape-n (${eolName}): \\n in a {link} string stays a backslash and an n in every version`, () => {
      for (const version of ['0.45.1', '0.51.3']) {
        const found = sp304(workspace(version, wrap('{link "a\\nb" "T"}x{/link}')));
        expect(found, version).toHaveLength(1);
        expect(found[0].message).toContain('"a\\\\nb"');
      }
    });
  }

  it('P1-default: without a detectable version the 0.45.1 behavior is used', () => {
    const model = new WorkspaceModel();
    model.initialize(new Map([[uri, ':: StoryVariables\n:: T\nx\n:: Start\n[[He said "hi"->T]]']]));
    models.push(model);
    expect(sp304(model)).toHaveLength(1);
  });

  it('P1-installed: the installed Spindle decides for the default workspace', () => {
    const model = workspace(undefined, ':: StoryVariables\n:: T\nx\n:: Start\n[[He said "hi"->T]]');
    expect(sp304(model)).toHaveLength(INSTALLED_CAPABILITIES.linkQuoteEscapes ? 0 : 1);
    expect(INSTALLED_SPINDLE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('P1-masked: script and attribute text holding link syntax is not a link', () => {
    const model = workspace('0.45.1', ':: StoryVariables\n:: T\nx\n:: code [script]\nconst a = "[[He said \\"hi\\"->T]]";\n:: Start\n<a title=\'[[say "x"->T]]\'>x</a>');
    expect(sp304(model)).toEqual([]);
  });
});

describe('P1 consumers: navigation follows the written target; the diagnostic names the runtime one', () => {
  const text = ':: StoryVariables\n:: T\nx\n:: Start\n[[He said "hi"->T]] {link "go" "T"}x{/link}';

  it('P1-refs: references, definition and document passage refs name T (the source), in every version', () => {
    for (const version of ['0.45.1', '0.51.3']) {
      const model = workspace(version, text);
      expect(findPassageReferences('T', model, false)).toHaveLength(2);
      const column = text.split('\n')[4].indexOf('T]]');
      expect(getDefinition(uri, { line: 4, character: column }, model)?.uri).toBe(uri);
      expect(parseDocumentPassageRefs(text, [], { linkQuoteEscapes: version === '0.51.3' }).map(r => r.name)).toEqual(['T', 'T']);
    }
  });

  it('P1-link-macro-target: the {link} target is the runtime one, decoded from 0.51.1', () => {
    const args = '"go" "a\\"b"';
    expect(resolveLinkMacroTarget(args, { linkQuoteEscapes: false })).toMatchObject({ name: 'a\\', form: 'link-string' });
    expect(resolveLinkMacroTarget(args, { linkQuoteEscapes: true })).toMatchObject({ name: 'a"b', start: 6, end: 10 });
    // and what the installed runtime navigates to
    const real = runtimeLinkMacro(args);
    expect(resolveLinkMacroTarget(args, installed)?.name).toBe(real.passage);
    expect(resolveLinkMacroTarget('"go" "{$x}"', installed)?.name).toBe('{$x}');
    expect(runtimeLinkMacro('"go" "{$x}"').passage).toBe('{$x}');
  });

  it('P1-rename-bracket: a name with a double quote cannot be written in a [[link]] before 0.51.1', () => {
    // (a line break cannot be a passage name: the header check rejects it first)
    const story = ':: StoryVariables\n:: Old\nx\n:: Start\n[[Old]]';
    const before = workspace('0.45.1', story);
    expect(() => computeRename(uri, { line: 1, character: 5 }, 'Bob"s', before)).toThrow(/double quote/);
    expect(() => computeRename(uri, { line: 1, character: 5 }, "Bob's", before)).not.toThrow();
    // from 0.51.1 the link macro reads the name back
    const after = workspace('0.51.3', story);
    const edits = computeRename(uri, { line: 1, character: 5 }, 'Bob"s', after);
    const output = TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, story), edits.get(uri) ?? []);
    expect(output).toBe(':: StoryVariables\n:: Bob"s\nx\n:: Start\n[[Bob"s]]');
    if (INSTALLED_CAPABILITIES.linkQuoteEscapes) expect(runtimeBracketLink('[[Bob"s]]')?.passage).toBe('Bob"s');
  });

  it('P1-rename-link-macro: from 0.51.1 the {link} string is escaped, before it the name is rejected', () => {
    const story = ':: StoryVariables\n:: Old\nx\n:: Start\n{link "go" "Old"}x{/link}';
    const before = workspace('0.45.1', story);
    expect(() => computeRename(uri, { line: 1, character: 5 }, 'a"b', before)).toThrow(RenameError);
    const after = workspace('0.51.3', story);
    const edits = computeRename(uri, { line: 1, character: 5 }, 'a"b\\c', after);
    const output = TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, story), edits.get(uri) ?? []);
    expect(output).toContain('{link "go" "a\\"b\\\\c"}');
    // the 0.51.3 runtime reads the new spelling back as the new name
    expect(resolveLinkMacroTarget('"go" "a\\"b\\\\c"', { linkQuoteEscapes: true })?.name).toBe('a"b\\c');
  });
});
