/**
 * Literal and source-context contracts promoted from the convergence corpus
 * (docs/reviews/process.md): X70/C-X70 (#70), R67/C-R67 (#67), L77 (#77).
 * Case IDs match test/review history. Runtime evaluation is restricted to
 * literals constructed by these tests.
 *
 * Spindle 0.59 reads the `passage` argument of {goto}, {include} and {link}
 * with `passageTarget`: a quoted string is a JavaScript string literal (the
 * name is its value), anything else an expression (a bare word or a template
 * literal included), which is no passage name.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { passageTarget, splitArgs, splitIncludeFlag } from '@rohal12/spindle/tooling';
import { tokenize } from '../helpers/tooling.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import type { Range } from '../../src/core/types.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeRename, RenameError } from '../../src/plugins/rename.js';
import { findPassageReferences } from '../../src/plugins/references.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { computeDocumentLinks } from '../../src/plugins/document-link.js';
import { computeCodeLenses } from '../../src/plugins/code-lens.js';
import { documentPassageRefs } from '../../src/core/markup/passage-refs.js';
import { decodeStringLiteralBody, encodeStringLiteralBody } from '../../src/core/parsing/js-string-literal.js';

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
/** The passage the macro `args` name at run time when they are a quoted string: its JavaScript value. */
function literalName(args: string) {
  const target = passageTarget(args);
  return target.kind === 'name' ? target.name : null;
}
/** The passage names written out in `text`, as references of the document. */
function refsOf(text: string) {
  return documentPassageRefs(workspace(text).markup.get(uri)!);
}

describe('R67: rename preserves literal meaning (#67)', () => {
  for (const [id, macro, delimiter, name] of [
    ['double', 'goto', '"', 'Bob"s'],
    ['single', 'goto', "'", "Bob's"],
    ['slash', 'include', '"', 'A\\B'],
  ]) {
    it(`R67-${id}: ${macro} literal`, () => {
      const model = workspace(`:: StoryVariables\n:: Old\nhello\n:: Start\n{${macro} ${delimiter}Old${delimiter}}`);
      const output = renamed(model, 1, 5, name);
      const args = runtimeMacroArgs(output).at(-1)!;
      // This is a fixed benign fixture, never document/project code.
      expect(new Function(`return (${args})`)()).toBe(name);
      expect(literalName(args)).toBe(name);
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
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n{print "[[Old]]"} {goto "Old"} {include "Old" inline} {link "go" "Old"}{/link}');
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
    expect(literalName(runtimeMacroArgs(output).at(-1)!)).toBe('A\\"B');
  });
  it('R67-line-breaks: a line break or separator in a name is escaped in a quoted target', () => {
    // A passage header cannot hold a line break, so the reference alone is rewritten here
    const text = ':: StoryVariables\n:: Old\nhello\n:: Start\n{goto "Old"} {goto \'Old\'}';
    const model = workspace(text);
    const refs = documentPassageRefs(model.markup.get(uri)!);
    for (const ref of refs) {
      const spelled = encodeStringLiteralBody('a\nb\r\u2028c', ref.quote!);
      expect(literalName(`${ref.quote}${spelled}${ref.quote}`)).toBe('a\nb\r\u2028c');
    }
  });
  it('R67-template: a template literal target is an expression: it is left as written, whatever the new name', () => {
    const text = ':: StoryVariables\n:: Old\nhello\n:: Start\n{goto `Old`} {goto "Old"}';
    const output = renamed(workspace(text), 1, 5, 'A${x}B');
    expect(output).toContain('{goto `Old`}');
    expect(evalLiteral(runtimeMacroArgs(output).at(-1)!)).toBe('A${x}B');
  });
  it('R67-other-quote-unescaped: the other quote kind needs no escape', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n{goto "Old"}');
    expect(renamed(model, 1, 5, "Bob's")).toContain('{goto "Bob\'s"}');
  });
  it('R67-bare: a bare target is an expression, left alone; the quoted one is renamed', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n{goto Old} {goto "Old"}');
    const output = renamed(model, 1, 5, 'New Name');
    expect(output).toContain('{goto Old} {goto "New Name"}');
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
  it('R67-link-macro: {link} reads its passage as a JavaScript string: a backslash and the delimiter are escaped', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n{link "go" "Old"}{/link}');
    const output = renamed(model, 1, 5, 'A\\B"C');
    expect(output).toContain('{link "go" "A\\\\B\\"C"}');
    const [, passage] = splitArgs(runtimeMacroArgs(output)[0]);
    expect(literalName(passage)).toBe('A\\B"C');
    expect(refsOf(output).map(r => r.name)).toEqual(['A\\B"C']);
  });
  it('R67-link-macro-header: a name a {link} string can hold but a header cannot is rejected by the header', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n{goto "Old"} {link "go" "Old"}{/link}');
    expect(() => computeRename(uri, { line: 1, character: 5 }, 'Bob"s', model)).not.toThrow();
    expect(() => computeRename(uri, { line: 1, character: 5 }, 'two\nlines', model)).toThrow(/single line/);
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
  it('R67-nested: a name in a label is escaped for the label string too, so the label still reads it back', () => {
    const text = ':: StoryVariables\n:: Old\nhello\n:: Start\n{button "Go {goto \'Old\'}"}{goto "Old"}{/button}';
    const output = renamed(workspace(text), 1, 5, "It's \"A\\B\"");
    // the label is a "-quoted string: `"` and `\` of the inner literal are escaped once more
    expect(refsOf(output).map(r => r.name)).toEqual(["It's \"A\\B\"", "It's \"A\\B\""]);
  });
  it('R67-attribute: a name in an attribute value is written inside the braces of its macro', () => {
    const text = ':: StoryVariables\n:: Old\nhello\n:: Start\n<a title="{goto \'Old\'}">x</a>';
    const model = workspace(text);
    // the braces protect the quotes: the attribute value goes on to its closing quote
    const output = renamed(model, 1, 5, 'a"b');
    expect(output).toContain('<a title="{goto \'a"b\'}">x</a>');
    expect(refsOf(output).map(r => r.name)).toEqual(['a"b']);
    expect(refsOf(renamed(model, 1, 5, "a'b")).map(r => r.name)).toEqual(["a'b"]);
  });
  it('R67-label-braces: a `{` in the name of a link without a label of its own would make the label markup', () => {
    const plain = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n[[Old]]');
    expect(() => computeRename(uri, { line: 1, character: 5 }, 'A{x}B', plain)).toThrow(RenameError);
    const labelled = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n[[Go->Old]]');
    expect(renamed(labelled, 1, 5, 'A{x}B')).toContain('[[Go->A{x}B]]');
  });
});

describe('L77 (extra): static literal decoding', () => {
  it('the remaining decoder agrees with passageTarget on the supported escapes', () => {
    for (const [quote, body] of [
      ['"', '\\u004eext'], ['"', '\\u{4e}ext'], ["'", '\\x4eext'], ['"', 'a\\nb\\tc\\0'],
      ['"', 'Say \\"hi\\"'], ['"', 'a\\\nb'], ['"', '\\q'],
    ] as const) {
      expect(literalName(`${quote}${body}${quote}`), body).toBe(decodeStringLiteralBody(body, quote));
    }
  });
  it('treats malformed or legacy escapes as undecidable: an expression, no name', () => {
    for (const body of ['\\u00', '\\x4', '\\u{110000}', '\\u{}', 'a\\']) {
      expect(decodeStringLiteralBody(body, '"'), body).toBeNull();
      expect(passageTarget(`"${body}"`).kind, body).toBe('expression');
    }
    expect(decodeStringLiteralBody('a"b', '"')).toBeNull();
    // non-strict JavaScript reads a legacy octal escape (the stricter decoder does not)
    expect(passageTarget('"\\1"')).toEqual({ kind: 'name', name: '\u0001' });
  });
  it('encode/read round-trip', () => {
    for (const quote of ['"', "'"] as const) {
      const value = 'a\\b"c\'d`e${f}\ng\r\u2028\u2029';
      expect(literalName(`${quote}${encodeStringLiteralBody(value, quote)}${quote}`)).toBe(value);
    }
  });
  it('L77-malformed-dynamic: malformed and dynamic targets are not static references', () => {
    expect(refsOf(':: StoryVariables\n:: Next\nhello\n:: Start\n{goto "\\u00"} {goto "\\u004e" + $x} {include `\\u004e${$x}`}')).toEqual([]);
  });
  it('L77-diagnostics: SP302 decodes the include target like the reference parser', () => {
    const sp302 = (args: string) => {
      const model = new WorkspaceModel();
      model.initialize(new Map([[uri, `:: StoryVariables\n:: Next [widget]\n{widget "greet"}hi{/widget}\n:: Start\n{include ${args}}\n`]]));
      models.push(model);
      return computeDiagnostics(uri, model).filter(d => d.code === 'SP302').length;
    };
    expect(sp302('"\\u004eext"')).toBe(1);
    expect(sp302('"\\x4eext" inline')).toBe(1);
    expect(sp302('"\\u00"')).toBe(0);
  });
  it('L77-range: the reference range keeps the original escaped spelling', () => {
    const [ref] = refsOf(':: Start\n{goto "\\u004eext"}');
    expect(ref.name).toBe('Next');
    expect(ref.range.start).toEqual({ line: 1, character: 7 });
    expect(ref.range.end).toEqual({ line: 1, character: 7 + '\\u004eext'.length });
  });
  it('L77-controls: only the quoted targets are references', () => {
    const refs = refsOf(':: Start\n{goto Next} {goto "Next"} {include "Next" inline} {include Next inline}');
    expect(refs.map(r => r.name)).toEqual(['Next', 'Next']);
  });
  it('L77-link-macro: {link} reads its passage as a JavaScript string, like {goto}', () => {
    const [ref] = refsOf(':: Start\n{link "go" "\\u004eext"}{/link}');
    expect(ref.name).toBe('Next');
    expect(ref.macro).toBe('link');
  });
});

describe('L77 (include target identity): references and SP302 read {include}', () => {
  function included(includeArgs: string, widget: string) {
    const model = new WorkspaceModel();
    const text = `:: StoryData\n{"format":"Spindle","format-version":"0.59.23"}\n:: StoryVariables\n` +
      `:: ${widget} [widget]\n{widget "greet"}hi{/widget}\n:: Start\n{include ${includeArgs}}\n`;
    model.initialize(new Map([[uri, text]]));
    models.push(model);
    return { model, text };
  }
  const identity = (args: string, widget: string) => {
    const { model } = included(args, widget);
    const refs = documentPassageRefs(model.markup.get(uri)!).filter(r => r.macro === 'include');
    return { names: refs.map(r => r.name), sp302: computeDiagnostics(uri, model).filter(d => d.code === 'SP302').length, refs };
  };

  // [args, passage tagged [widget], reference names, SP302 count]: the flag is the first or last word
  // outside quotes; what is left is a quoted name or an expression (no name)
  const rows: Array<[string, string, string, string[], number]> = [
    ['L77/include-inline-diagnostic-quoted', '"inline"', 'inline', ['inline'], 1],
    ['L77/include-inline-diagnostic-quoted-flag-after', '"inline" inline', 'inline', ['inline'], 1],
    ['L77/include-inline-diagnostic-flag-before', 'inline "inline"', 'inline', ['inline'], 1],
    ['L77/include-inline-diagnostic-escaped', '"\\u0069nline"', 'inline', ['inline'], 1],
    ['L77/include-widget-other-quoted', '"Other"', 'Other', ['Other'], 1],
    ['L77/include-widget-other-bare', 'Other', 'Other', [], 0],
    ['L77/include-widget-other-flag-after', '"Other" inline', 'Other', ['Other'], 1],
    ['L77/include-widget-other-flag-before', 'inline "Other"', 'Other', ['Other'], 1],
    ['L77/include-widget-other-bare-flag-after', 'Other inline', 'Other', [], 0],
    ['L77/include-malformed-escape', '"\\u00"', 'Other', [], 0],
    ['L77/include-dynamic-variable', '$x', 'Other', [], 0],
    ['L77/include-dynamic-concat', '"Other" + $x', 'Other', [], 0],
  ];
  for (const [id, args, widget, names, sp302] of rows) {
    it(`${id}: reference identity and SP302 agree`, () => {
      const got = identity(args, widget);
      expect(got.names, `reference names for {include ${args}}`).toEqual(names);
      expect(got.sp302, `SP302 for {include ${args}}`).toBe(sp302);
    });
  }

  it('L77/include-inline-resolver-flags: the flag is read as splitIncludeFlag does', () => {
    // SP302 fires for exactly the arguments whose passage is a quoted name, after the flag is taken off
    for (const args of ['"Other" inline', 'inline "Other"', 'Other inline', '$x', '"\\u00"', '"inline"', '"inline" inline']) {
      const target = passageTarget(splitIncludeFlag(args).passage ?? '');
      const name = target.kind === 'name' ? target.name : undefined;
      const got = identity(args, name ?? 'Other');
      expect(got.names, args).toEqual(name === undefined ? [] : [name]);
      expect(got.sp302, args).toBe(name === undefined ? 0 : 1);
    }
  });

  it('L77/include-inline-range: the reference keeps the original escaped spelling', () => {
    const { refs } = identity('"\\u0069nline" ', 'inline');
    expect(refs.map(r => r.name)).toEqual(['inline']);
    const [ref] = refs;
    expect(ref.range.end.character - ref.range.start.character).toBe('\\u0069nline'.length);
  });

  it('L77/include-inline-argument-check: the argument validation reads the flag like the resolver', () => {
    const argCodes = (args: string) => {
      const { model } = included(args, 'Other');
      return computeDiagnostics(uri, model).filter(d => /^SP1/.test(String(d.code))).map(d => d.code);
    };
    expect(argCodes('"inline"')).toEqual(argCodes('"Other"'));
  });
});

describe('R67/X70 (CRLF): quoted passage targets', () => {
  const crlf = (text: string) => text.replace(/\n/g, '\r\n');
  // astral characters make UTF-16 columns differ from code points
  const source = crlf(':: StoryVariables\n:: Old\nhello\n:: Start\n\u{1F600}{goto "Old"} {include \'Old\'}\n{print "Old"} [[Old]]');

  it('R67-crlf: ranges, rename edits and meaning survive CRLF', () => {
    const model = workspace(source);
    const refs = documentPassageRefs(model.markup.get(uri)!).filter(r => r.name === 'Old');
    expect(refs).toHaveLength(3);
    for (const ref of refs) {
      expect(ref.range.start.line).toBe(ref.range.end.line);
      const line = source.split('\r\n')[ref.range.start.line];
      expect(line.slice(ref.range.start.character, ref.range.end.character)).toBe('Old');
    }
    const output = renamed(model, 1, 5, 'A`$\\B');
    // CRLF line endings and unrelated text are preserved
    expect(output.split('\r\n')).toHaveLength(source.split('\r\n').length);
    expect(output.replace(/\r\n/g, '\n')).not.toMatch(/(?<!\r)\r(?!\n)/);
    const args = runtimeMacroArgs(output).filter(a => /^["']/.test(a));
    for (const a of args.slice(0, 2)) expect(new Function(`return (${a})`)()).toBe('A`$\\B');
    expect(output).toContain('\u{1F600}{goto "A`$\\\\B"}');
  });

  it('R67-crlf-multiline: a target on a later line after CRLF', () => {
    const text = crlf(':: StoryVariables\n:: Old\nhello\n:: Start\ntext\n{goto\n  "Old"}');
    const model = workspace(text);
    const output = renamed(model, 1, 5, 'New');
    expect(output).toBe(crlf(':: StoryVariables\n:: New\nhello\n:: Start\ntext\n{goto\n  "New"}'));
  });

  it('X70-crlf-diagnostics: a broken link beside a quoted target diagnoses the same as LF', () => {
    const ok = workspace(source);
    expect(codes(ok)).toEqual(codes(workspace(source.replace(/\r\n/g, '\n'))));
    const broken = crlf(':: StoryVariables\n:: Start\n{goto "Start"} [[Ghost]]');
    expect(codes(workspace(broken))).toContain('SP300');
    expect(codes(workspace(broken))).toEqual(codes(workspace(broken.replace(/\r\n/g, '\n'))));
  });

  it('X70-crlf-controls: dynamic targets are not static under CRLF', () => {
    const text = crlf(':: StoryVariables\n:: Old\nhello\n:: Start\n{goto "O" + $x}\n{goto `Old`}\n{goto "Old"}');
    expect(refsOf(text).map(r => r.name)).toEqual(['Old']);
  });
});
