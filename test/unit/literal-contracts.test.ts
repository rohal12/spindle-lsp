/**
 * Literal and source-context contracts promoted from the convergence corpus
 * (docs/reviews/process.md): X70/C-X70 (#70), R67/C-R67 (#67), L77 (#77).
 * Case IDs match test/review history. Runtime evaluation is restricted to
 * literals constructed by these tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { tokenize } from '../helpers/tooling.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import type { Range } from '../../src/core/types.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeRename, RenameError } from '../../src/plugins/rename.js';
import { findPassageReferences } from '../../src/plugins/references.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { computeDocumentLinks } from '../../src/plugins/document-link.js';
import { computeCodeLenses } from '../../src/plugins/code-lens.js';
import { resolveIncludeTarget } from '../../src/plugins/diagnostics.js';
import { parseMacroPassageRefs } from '../../src/core/parsing/link-parser.js';
import { decodeStringLiteralBody, encodeStringLiteralBody } from '../../src/core/parsing/js-string-literal.js';

import { INSTALLED_CAPABILITIES } from '../helpers/spindle-version.js';

const uri = 'file:///story.tw';
const models: WorkspaceModel[] = [];
function workspace(text: string, extra: Array<[string, string]> = []) {
  const model = new WorkspaceModel({ workspaceRoot: process.cwd() });
  model.initialize(new Map([...extra, [uri, text]]));
  models.push(model);
  return model;
}
afterEach(() => { for (const model of models.splice(0)) model.dispose(); });

function apply(text: string, edits: Array<{ range: Range; newText: string }>) {
  return TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, text), edits);
}
function renamed(model: WorkspaceModel, line: number, character: number, name: string) {
  const edits = computeRename(uri, { line, character }, name, model);
  return apply(model.documents.getText(uri)!, edits.get(uri) ?? []);
}
function codes(model: WorkspaceModel) {
  return computeDiagnostics(uri, model).map(d => d.code);
}
function runtimeMacroArgs(text: string) {
  return tokenize(text).filter(t => t.type === 'macro').map(t => t.rawArgs);
}

describe('R67: rename preserves literal meaning (#67)', () => {
  for (const [id, macro, delimiter, name] of [
    ['double', 'goto', '"', 'Bob"s'],
    ['single', 'goto', "'", "Bob's"],
    ['slash', 'include', '"', 'A\\B'],
    ['template', 'goto', '`', 'A`B'],
  ]) {
    it(`R67-${id}: ${macro} literal`, () => {
      const model = workspace(`:: StoryVariables\n:: Old\nhello\n:: Start\n{${macro} ${delimiter}Old${delimiter}}`);
      const output = renamed(model, 1, 5, name);
      const args = runtimeMacroArgs(output).at(-1)!;
      // This is a fixed benign fixture, never document/project code.
      expect(new Function(`return (${args})`)()).toBe(name);
    });
  }
  it('C-R67: ordinary header and bracket link rename agree', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n[[Old]]');
    const output = renamed(model, 1, 5, 'New');
    expect(output).toContain(':: New\n');
    expect(tokenize(output).filter(t => t.type === 'link').map(t => t.target)).toEqual(['New']);
  });
});

describe('X70: passage references honor source context (#70)', () => {
  for (const [id, body] of [
    ['macro-string', '{print "[[Old]]"}'],
    ['attribute', '<div title="[[Old]]">x</div>'],
    ['script', ':: Code [script]\nconst docs = "[[Old]]";'],
    ['stylesheet', ':: CSS [stylesheet]\na::after { content: "[[Old]]"; }'],
  ]) {
    for (const feature of ['references', 'rename', 'definition', 'document-links', 'code-lenses', 'diagnostics']) {
      it(`X70-${id}-${feature}: literal context`, () => {
        if (id === 'macro-string' || id === 'attribute') {
          expect(tokenize(body).filter(t => t.type === 'link')).toHaveLength(0);
        }
        const text = `:: StoryVariables\n:: Old\nhello\n:: Start\n${body}`;
        const model = workspace(text);
        if (feature === 'references') expect(findPassageReferences('Old', model, false)).toHaveLength(0);
        if (feature === 'rename') expect(renamed(model, 1, 5, 'New')).toContain(body);
        if (feature === 'definition') {
          const position = TextDocument.create(uri, 'twee', 0, text).positionAt(text.lastIndexOf('Old') + 1);
          expect(getDefinition(uri, position, model)).toBeNull();
        }
        if (feature === 'document-links') expect(computeDocumentLinks(uri, model)).toHaveLength(0);
        if (feature === 'code-lenses') expect(computeCodeLenses(uri, model).find(l => l.range.start.line === 1)?.command.title).toBe('0 references');
        if (feature === 'diagnostics') expect(codes(workspace(text.replace(':: Old', ':: Target')))).not.toContain('SP300');
      });
    }
  }
  it('C-X70: real links and goto literals are references', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n[[Old]] {goto "Old"}');
    expect(findPassageReferences('Old', model, false)).toHaveLength(2);
    expect(getDefinition(uri, { line: 4, character: 3 }, model)?.uri).toBe(uri);
  });
});

describe('L77: decode static JavaScript literals (#77)', () => {
  for (const [id, spelling] of [['unicode', '\\u004eext'], ['hex', '\\x4eext']]) {
    for (const macro of ['goto', 'include']) {
      it(`L77-${id}-${macro}: decoded target has a definition and rename`, () => {
        expect(new Function(`return ("${spelling}")`)()).toBe('Next');
        const model = workspace(`:: StoryVariables\n:: Next\nhello\n:: Start\n{${macro} "${spelling}"}`);
        expect(findPassageReferences('Next', model, false)).toHaveLength(1);
        expect(getDefinition(uri, { line: 4, character: macro.length + 4 }, model)?.uri).toBe(uri);
        const output = renamed(model, 1, 5, 'Other');
        expect(new Function(`return (${runtimeMacroArgs(output).at(-1)})`)()).toBe('Other');
      });
    }
  }
});


describe('X70 (extra): literal context variants and nearby controls', () => {
  it('X70-print-template: a bracket text inside a template argument is not a link', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n{print `[[Old]]`}');
    expect(findPassageReferences('Old', model, false)).toHaveLength(0);
  });
  it('X70-attribute-single-quote: attribute values with single quotes are literal', () => {
    const model = workspace(":: StoryVariables\n:: Old\nhello\n:: Start\n<a title='[[Old]]'>x</a>");
    expect(findPassageReferences('Old', model, false)).toHaveLength(0);
  });
  it('X70-script-rename-quote: renaming does not break script strings', () => {
    const body = ':: Code [script]\nconst docs = "[[Old]]";';
    const model = workspace(`:: StoryVariables\n:: Old\nhello\n:: Start\n[[Old]]\n${body}`);
    const output = renamed(model, 1, 5, "Bob's");
    expect(output).toContain(body);
    expect(output).toContain("[[Bob's]]");
  });
  it('C-X70-link-variants: pipe, arrow, reverse and CSS-prefixed links are references', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n[[a|Old]] [[b->Old]] [[Old<-c]] [[.cls#id Old]]');
    expect(findPassageReferences('Old', model, false)).toHaveLength(4);
    const output = renamed(model, 1, 5, 'New');
    expect(tokenize(output).filter(t => t.type === 'link').map(t => t.target)).toEqual(['New', 'New', 'New', 'New']);
  });
  it('C-X70-macro-targets: goto/include/link string targets stay references next to literal text', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n{print "[[Old]]"} {goto "Old"} {include Old inline} {link "go" "Old"}{/link}');
    expect(findPassageReferences('Old', model, false)).toHaveLength(3);
    const output = renamed(model, 1, 5, 'New');
    expect(output).toContain('{print "[[Old]]"}');
    expect(output).toContain('{goto "New"} {include "New" inline} {link "go" "New"}');
  });
  it('C-X70-link-in-macro-body: a link inside a block macro body is a reference', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n{if true}[[Old]]{/if}');
    expect(findPassageReferences('Old', model, false)).toHaveLength(1);
  });
  it('C-X70-diagnostics: a genuinely broken link is still diagnosed', () => {
    expect(codes(workspace(':: StoryVariables\n:: Start\n[[Ghost]] {print "[[Ghost2]]"}'))).toEqual(['SP300']);
  });
});

describe('R67 (extra): per-context encoding', () => {
  const evalLiteral = (args: string) => new Function(`return (${args})`)();
  it('R67-backslash-quote: both a delimiter and a backslash are escaped', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n{goto "Old"}');
    const output = renamed(model, 1, 5, 'A\\"B');
    expect(evalLiteral(runtimeMacroArgs(output).at(-1)!)).toBe('A\\"B');
  });
  it('R67-template-interpolation: ${ in a template target is escaped', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n{goto `Old`}');
    const output = renamed(model, 1, 5, 'A${x}B');
    expect(evalLiteral(runtimeMacroArgs(output).at(-1)!)).toBe('A${x}B');
  });
  it('R67-other-quote-unescaped: the other quote kind needs no escape', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n{goto "Old"}');
    expect(renamed(model, 1, 5, "Bob's")).toContain('{goto "Bob\'s"}');
  });
  it('R67-bare: a bare target that cannot stay bare is quoted', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n{goto Old}');
    expect(renamed(model, 1, 5, 'New Name')).toContain('{goto New Name}');
    const quoted = renamed(model, 1, 5, 'a(b)');
    expect(evalLiteral(runtimeMacroArgs(quoted).at(-1)!)).toBe('a(b)');
  });
  it('R67-bracket-multifile: bracket links in other files keep syntax and unrelated text', () => {
    const other = 'file:///other.tw';
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n[[x|Old]] {goto "Old"}', [[other, ':: Other\nbefore [[Old]] after']]);
    const edits = computeRename(uri, { line: 1, character: 5 }, "Bob's", model);
    expect(apply(model.documents.getText(other)!, edits.get(other) ?? [])).toBe(":: Other\nbefore [[Bob's]] after");
    expect(apply(model.documents.getText(uri)!, edits.get(uri) ?? [])).toBe(":: StoryVariables\n:: Bob's\nhello\n:: Start\n[[x|Bob's]] {goto \"Bob's\"}");
  });
  it('R67-link-macro: {link} reads quoted text verbatim before 0.51.1, so a backslash is kept as is', () => {
    const escapes = INSTALLED_CAPABILITIES.linkQuoteEscapes;
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n{link "go" "Old"}{/link}');
    const output = renamed(model, 1, 5, 'A\\B');
    expect(output).toContain(escapes ? '{link "go" "A\\\\B"}' : '{link "go" "A\\B"}');
    expect(parseMacroPassageRefs(output, 0, { linkQuoteEscapes: escapes }).map(r => r.name)).toEqual(['A\\B']);
  });
  it('R67-reject-link-macro: a name its {link} string cannot hold is rejected with no edits (before 0.51.1)', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n{goto "Old"} {link "go" "Old"}{/link}');
    if (INSTALLED_CAPABILITIES.linkQuoteEscapes) {
      // 0.51.1 escapes the delimiter, so these names are representable (L-quote tests)
      expect(() => computeRename(uri, { line: 1, character: 5 }, 'Bob"s', model)).not.toThrow();
      return;
    }
    expect(() => computeRename(uri, { line: 1, character: 5 }, 'Bob"s', model)).toThrow(RenameError);
    expect(() => computeRename(uri, { line: 1, character: 5 }, 'two\nlines', model)).toThrow(/{link}/);
  });
  it('R67-reject-bracket: names a [[link]] cannot hold are rejected', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n[[Old]]');
    for (const name of ['a|b', 'a->b', 'a<-b', 'a]]b', ' pad']) {
      expect(() => computeRename(uri, { line: 1, character: 5 }, name, model), name).toThrow(RenameError);
    }
  });
  it('R67-reject-ok-without-bracket: the same names rename fine when only goto references exist', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n{goto "Old"}');
    const output = renamed(model, 1, 5, 'a|b');
    expect(evalLiteral(runtimeMacroArgs(output).at(-1)!)).toBe('a|b');
  });
});

describe('L77 (extra): static literal decoding', () => {
  it('decodes the supported escapes', () => {
    expect(decodeStringLiteralBody('\\u004eext', '"')).toBe('Next');
    expect(decodeStringLiteralBody('\\u{4e}ext', '"')).toBe('Next');
    expect(decodeStringLiteralBody('\\x4eext', "'")).toBe('Next');
    expect(decodeStringLiteralBody('a\\nb\\tc\\0', '`')).toBe('a\nb\tc\0');
    expect(decodeStringLiteralBody('Say \\"hi\\"', '"')).toBe('Say "hi"');
    expect(decodeStringLiteralBody('a\\\nb', '"')).toBe('ab');
    expect(decodeStringLiteralBody('\\q', '"')).toBe('q');
  });
  it('treats malformed or legacy escapes as undecidable', () => {
    for (const body of ['\\u00', '\\x4', '\\u{110000}', '\\u{}', '\\1', '\\00', 'a\\', 'a\nb']) {
      expect(decodeStringLiteralBody(body, '"'), body).toBeNull();
    }
    expect(decodeStringLiteralBody('a"b', '"')).toBeNull();
  });
  it('encode/decode round-trip', () => {
    for (const quote of ['"', "'", '`'] as const) {
      const value = 'a\\b"c\'d`e${f}\ng\r\u2028';
      expect(decodeStringLiteralBody(encodeStringLiteralBody(value, quote), quote)).toBe(value);
    }
  });
  it('L77-malformed-dynamic: malformed and dynamic targets are not static references', () => {
    const model = workspace(':: StoryVariables\n:: Next\nhello\n:: Start\n{goto "\\u00"} {goto "\\u004e" + $x} {include `\\u004e${$x}`}');
    expect(parseMacroPassageRefs(model.documents.getText(uri)!)).toEqual([]);
  });
  it('L77-diagnostics: the include-target resolver decodes like the reference parser', () => {
    expect(resolveIncludeTarget('"\\u004eext"')).toBe('Next');
    expect(resolveIncludeTarget('"\\x4eext" inline')).toBe('Next');
    expect(resolveIncludeTarget('"\\u00"')).toBeNull();
  });
  it('L77-range: the reference range keeps the original escaped spelling', () => {
    const [ref] = parseMacroPassageRefs('{goto "\\u004eext"}');
    expect(ref.name).toBe('Next');
    expect(ref.range.start.character).toBe(7);
    expect(ref.range.end.character).toBe(7 + '\\u004eext'.length);
  });
  it('L77-controls: bare, quoted and include-inline targets keep working', () => {
    const refs = parseMacroPassageRefs('{goto Next} {goto "Next"} {include "Next" inline} {include Next inline}');
    expect(refs.map(r => r.name)).toEqual(['Next', 'Next', 'Next', 'Next']);
  });
  it('L77-link-macro: {link} is not run through the JavaScript codec', () => {
    const [ref] = parseMacroPassageRefs('{link "go" "\\u004eext"}{/link}');
    expect(ref.name).toBe('\\u004eext');
  });
});

describe('L77 (include target identity): references and SP302 read {include} per release', () => {
  // No workspace root, so the version comes from StoryData and never from the installed runtime.
  function versioned(version: string, includeArgs: string, widget = 'inline') {
    const model = new WorkspaceModel();
    const text = `:: StoryData\n{"format":"Spindle","format-version":"${version}"}\n:: StoryVariables\n` +
      `:: ${widget} [widget]\n{widget "greet"}hi{/widget}\n:: Start\n{include ${includeArgs}}\n`;
    model.initialize(new Map([[uri, text]]));
    models.push(model);
    return { model, text };
  }
  const identity = (version: string, args: string, widget = 'inline') => {
    const { model, text } = versioned(version, args, widget);
    const refs = parseMacroPassageRefs(text, 0, model.capabilities).filter(r => r.macro === 'include');
    const sp302 = computeDiagnostics(uri, model).filter(d => d.code === 'SP302');
    return { names: refs.map(r => r.name), sp302: sp302.length, model, text, refs };
  };

  // [args, passage tagged [widget], per version: reference names, SP302 count]
  type Row = [string, string, Record<string, [string[], number]>];
  const OLD = '0.45.1', MID = '0.51.1', NEW = '0.51.3';
  const rows: Array<[string, Row]> = [
    ['L77/include-inline-diagnostic-quoted', ['"inline"', 'inline', { [OLD]: [[], 0], [MID]: [['inline'], 1], [NEW]: [['inline'], 1] }]],
    ['L77/include-inline-diagnostic-quoted-flag-after', ['"inline" inline', 'inline', { [OLD]: [[], 0], [MID]: [['inline'], 1], [NEW]: [['inline'], 1] }]],
    ['L77/include-inline-diagnostic-flag-before', ['inline "inline"', 'inline', { [OLD]: [['inline'], 1], [MID]: [['inline'], 1], [NEW]: [['inline'], 1] }]],
    ['L77/include-inline-diagnostic-escaped', ['"\\u0069nline"', 'inline', { [OLD]: [['inline'], 1], [MID]: [['inline'], 1], [NEW]: [['inline'], 1] }]],
    ['L77/include-widget-other-quoted', ['"Other"', 'Other', { [OLD]: [['Other'], 1], [MID]: [['Other'], 1], [NEW]: [['Other'], 1] }]],
    ['L77/include-widget-other-bare', ['Other', 'Other', { [OLD]: [['Other'], 1], [MID]: [['Other'], 1], [NEW]: [['Other'], 1] }]],
    ['L77/include-widget-other-flag-after', ['"Other" inline', 'Other', { [OLD]: [['Other'], 1], [MID]: [['Other'], 1], [NEW]: [['Other'], 1] }]],
    ['L77/include-widget-other-flag-before', ['inline Other', 'Other', { [OLD]: [['Other'], 1], [MID]: [['Other'], 1], [NEW]: [['Other'], 1] }]],
    ['L77/include-widget-other-bare-flag-after', ['Other inline', 'Other', { [OLD]: [['Other'], 1], [MID]: [['Other'], 1], [NEW]: [['Other'], 1] }]],
    ['L77/include-malformed-escape', ['"\\u00"', 'Other', { [OLD]: [[], 0], [MID]: [[], 0], [NEW]: [[], 0] }]],
    ['L77/include-dynamic-variable', ['$x', 'Other', { [OLD]: [[], 0], [MID]: [[], 0], [NEW]: [[], 0] }]],
    ['L77/include-dynamic-concat', ['"Other" + $x', 'Other', { [OLD]: [[], 0], [MID]: [[], 0], [NEW]: [[], 0] }]],
  ];
  for (const [id, [args, widget, expected]] of rows) {
    for (const version of [OLD, MID, NEW]) {
      it(`${id}-${version}: reference identity and SP302 agree`, () => {
        const want = expected[version];
        const got = identity(version, args, widget);
        expect(got.names, `reference names for {include ${args}}`).toEqual(want[0]);
        expect(got.sp302, `SP302 for {include ${args}}`).toBe(want[1]);
      });
    }
  }

  it('L77/include-inline-diagnostic-0.51.3: the SP302 of a widget passage named inline', () => {
    const { model } = versioned(NEW, '"inline"');
    expect(model.capabilities.includeInlineScoped).toBe(true);
    expect(resolveIncludeTarget('"inline"', model.capabilities)).toBe('inline');
    // 0.45.1 removes the word even inside the quotes, leaving the empty string
    expect(resolveIncludeTarget('"inline"')).toBe('');
    expect(computeDiagnostics(uri, model).map(d => d.code)).toContain('SP302');
  });

  it('L77/include-inline-resolver-flags: leading and trailing flags per release', () => {
    const scoped = { includeInlineScoped: true };
    for (const options of [{}, scoped]) {
      expect(resolveIncludeTarget('"Other" inline', options)).toBe('Other');
      expect(resolveIncludeTarget('inline "Other"', options)).toBe('Other');
      expect(resolveIncludeTarget('Other inline', options)).toBe('Other');
      expect(resolveIncludeTarget('$x', options)).toBeNull();
      expect(resolveIncludeTarget('"\\u00"', options)).toBeNull();
    }
    expect(resolveIncludeTarget('"inline"', {})).toBe('');
    expect(resolveIncludeTarget('"inline"', scoped)).toBe('inline');
    expect(resolveIncludeTarget('"inline" inline', scoped)).toBe('inline');
  });

  it('L77/include-inline-range: the reference keeps the original escaped spelling on every release', () => {
    for (const version of [OLD, MID, NEW]) {
      const { refs } = identity(version, '"\\u0069nline" ');
      expect(refs.map(r => r.name)).toEqual(['inline']);
      const [ref] = refs;
      expect(ref.range.end.character - ref.range.start.character).toBe('\\u0069nline'.length);
    }
  });

  it('L77/include-inline-argument-check: the argument validation reads the flag like the resolver', () => {
    const argCodes = (version: string, args: string) => {
      const { model } = versioned(version, args, 'Other');
      return computeDiagnostics(uri, model).filter(d => /^SP1/.test(String(d.code))).map(d => d.code);
    };
    for (const version of [OLD, MID, NEW]) {
      expect(argCodes(version, '"inline"'), version).toEqual(argCodes(version, '"Other"'));
    }
  });
});

describe('R67/X70 (CRLF): template-literal passage targets', () => {
  const crlf = (text: string) => text.replace(/\n/g, '\r\n');
  // astral characters make UTF-16 columns differ from code points
  const source = crlf(':: StoryVariables\n:: Old\nhello\n:: Start\n\u{1F600}{goto `Old`} {include `Old`}\n{print `Old`} [[Old]]');

  it('R67-template-crlf: ranges, rename edits and meaning survive CRLF', () => {
    const model = workspace(source);
    const refs = parseMacroPassageRefs(source).filter(r => r.name === 'Old');
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const ref of refs) {
      expect(ref.range.start.line).toBe(ref.range.end.line);
      const line = source.split('\r\n')[ref.range.start.line];
      expect(line.slice(ref.range.start.character, ref.range.end.character)).toBe('Old');
    }
    const output = renamed(model, 1, 5, 'A`${x}\\B');
    // CRLF line endings and unrelated text are preserved
    expect(output.split('\r\n')).toHaveLength(source.split('\r\n').length);
    expect(output.replace(/\r\n/g, '\n')).not.toMatch(/(?<!\r)\r(?!\n)/);
    const args = runtimeMacroArgs(output).filter(a => a.startsWith('`'));
    for (const a of args.slice(0, 2)) expect(new Function(`return (${a})`)()).toBe('A`${x}\\B');
    expect(output).toContain('\u{1F600}{goto `A\\`\\${x}\\\\B`}');
  });

  it('R67-template-crlf-multiline: a template target on a later line after CRLF', () => {
    const text = crlf(':: StoryVariables\n:: Old\nhello\n:: Start\ntext\n{goto\n  `Old`}');
    const model = workspace(text);
    const output = renamed(model, 1, 5, 'New');
    expect(output).toBe(crlf(':: StoryVariables\n:: New\nhello\n:: Start\ntext\n{goto\n  `New`}'));
  });

  it('X70-template-crlf-diagnostics: a broken link beside a template target diagnoses the same as LF', () => {
    const ok = workspace(source);
    expect(codes(ok)).toEqual(codes(workspace(source.replace(/\r\n/g, '\n'))));
    const broken = crlf(':: StoryVariables\n:: Start\n{goto `Start`} [[Ghost]]');
    expect(codes(workspace(broken))).toContain('SP300');
    expect(codes(workspace(broken))).toEqual(codes(workspace(broken.replace(/\r\n/g, '\n'))));
  });

  it('X70-template-crlf-controls: dynamic templates are not static targets under CRLF', () => {
    const text = crlf(':: StoryVariables\n:: Old\nhello\n:: Start\n{goto `O${$x}`}\n{goto `Old`}');
    expect(parseMacroPassageRefs(text).map(r => r.name)).toEqual(['Old']);
  });
});
