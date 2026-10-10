/**
 * Contract Q-link-interp: what Spindle interpolates in a link, and every
 * consumer of that fact.
 *
 * Runtime truth (Spindle 0.59; the macros' declared parameters in the public
 * `builtinMacros`, and `passagePieces`, say what holds markup): the `{link}`
 * macro, which every bracket link becomes (`[[Take {$item}->T]]` is
 * `{link "Take {$item}" "T"}`), declares its `text` as a string holding
 * markup, so the label is resolved (`Take 3`), while its `passage` is a name
 * read as a JavaScript literal: `[[Go->T{$n}]]` navigates to a passage named
 * `T{$n}`. The link's `.class#id` selectors are interpolated (the macro is
 * `interpolate: true`), and so are HTML attribute values and the labels of
 * `{button}`, `{dialog}` and `{meter}`. A string in any other macro's
 * arguments is JavaScript, not a template. (Up to 0.51.3 the link macro
 * printed its text as written; see docs/reviews/2026-10-10-tooling-migration.md.)
 *
 * Q-source pins that reading to the installed runtime's macro metadata;
 * Q-differential compares the variable usages the LSP records with what the
 * runtime's interpolation reads (test/helpers/interpolation-oracle.ts, the
 * closest public equivalent of the runtime's own, which is not exported);
 * Q-diagnostic covers SP305; Q-rename applies the rename edits and reparses;
 * Q-validation compares SP200 with the installed startup validation (needs
 * upstream API: test/helpers/story-variables-oracle.ts). Every case runs with
 * LF and CRLF.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { builtinMacros } from '@rohal12/spindle/tooling';
import { everyNameScope, interpolate, interpolationReads } from '../helpers/interpolation-oracle.js';
import { runtimeVariableReads } from '../helpers/variable-reads-oracle.js';
import { tokenize } from '../helpers/tooling.js';
import { parseStoryVariables, validatePassages } from '../helpers/story-variables-oracle.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { LITERAL_ARGUMENT_MACROS, VariableTracker } from '../../src/core/workspace/variable-tracker.js';
import { findLiteralLinkInterpolations, findBracketLinks, linkSelectorInterpolationRanges } from '../../src/core/parsing/link-parser.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeRename } from '../../src/plugins/rename.js';
import { findVariableReferences } from '../../src/plugins/references.js';
import { computeCodeLenses } from '../../src/plugins/code-lens.js';
import type { Range } from '../../src/core/types.js';
import { INSTALLED_CAPABILITIES } from '../helpers/spindle-version.js';
import { runtimeBracketLink, runtimeLinkMacro } from '../helpers/link-macro-oracle.js';

const uri = 'file:///story.tw';
const eols = [['LF', '\n'], ['CRLF', '\r\n']] as const;

const models: WorkspaceModel[] = [];
function workspace(text: string): WorkspaceModel {
  const model = new WorkspaceModel({ workspaceRoot: process.cwd() });
  model.initialize(new Map([[uri, text]]));
  models.push(model);
  return model;
}
afterEach(() => { for (const model of models.splice(0)) model.dispose(); });

function apply(text: string, edits: Array<{ range: Range; newText: string }> | undefined): string {
  return TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, text), edits ?? []);
}

describe('Q-source: what the installed runtime interpolates', () => {
  const byName = new Map(builtinMacros.map(m => [m.name, m]));
  /** The macros that declare a string argument holding markup, with the parameter. */
  const markupStrings = () => builtinMacros
    .flatMap(m => (m.parameters ?? []).filter(p => (p.type === 'string' || p.type === 'text') && p.holds === 'markup').map(p => `${m.name}:${p.name}`))
    .sort();

  it('Q-source-link: the link macro resolves its text as markup; its passage is a name read as written', () => {
    const link = byName.get('link');
    expect(link?.interpolate, 'class and id are resolved by the macro wrapper').toBe(true);
    expect(link?.parameters?.map(p => [p.name, p.type, p.holds])).toEqual([['text', 'string', 'markup'], ['passage', 'passage', undefined]]);
  });

  it('Q-source-args: {button}, {dialog}, {link} and {meter} resolve a string argument; {if} and {timed} resolve section selectors', () => {
    expect(markupStrings()).toEqual(['button:label', 'dialog:label', 'link:text', 'meter:label']);
    expect(['if', 'timed'].map(name => byName.get(name)?.interpolate)).toEqual([true, true]);
  });

  it('Q-source-registry: every built-in macro is classified (a new one forces a decision)', () => {
    const registry = builtinMacros;
    const classified = new Set([...LITERAL_ARGUMENT_MACROS, 'button', 'dialog']);
    expect(registry.map(m => m.name).filter(name => !classified.has(name))).toEqual([]);
    // and the literal list holds nothing the runtime does not ship
    const shipped = new Set(registry.map(m => m.name));
    expect([...LITERAL_ARGUMENT_MACROS].filter(name => !shipped.has(name))).toEqual([]);
  });
});

/** Whether interpolate() would change `template` (it evaluates some block in it). */
function interpolates(template: string): boolean {
  const value = everyNameScope('V');
  try {
    return interpolate(template, value, value, value, value) !== template;
  } catch {
    return true;
  }
}

describe('Q-differential: variable usages are what the runtime interpolates', () => {
  const oracleReads = runtimeVariableReads;

  function oursReads(text: string): string[] {
    const tracker = new VariableTracker();
    tracker.setCapabilities(INSTALLED_CAPABILITIES);
    tracker.scanDocument(uri, `:: P\n${text}`, []);
    return ['x', 'a', 'b', 't', 'u', 'k', 'y', 'n', 'item']
      .flatMap(name => [
        ...tracker.getUsages(name).map(() => name),
        ...tracker.getTransientUsages(name).map(() => name),
      ])
      .sort();
  }

  const fixtures: Array<[string, string]> = [
    ['display', '[[Take {$item}->T]]'],
    ['target', '[[Go->T{$n}]]'],
    ['single text', '[[Take {$item}]]'],
    ['pipe form', '[[Take {$a}|T{$b}]]'],
    ['reverse form', '[[T{$b}<-Take {$a}]]'],
    ['transient in the label', '[[{%t}->T]]'],
    ['class selector', '[[.c{$k} Go->T]]'],
    ['id selector', '[[#i{$y} Go->T]]'],
    ['selectors, label and target together', '[[.c{$k}#i{$y} Take {$a}->T{$b}]]'],
    ['expression in the label', '[[Hi {$a + $b}->T]]'],
    ['{link} strings', '{link "Take {$item}" "T{$n}"}x{/link}'],
    ['{link} single quotes', "{link 'Take {$item}' 'T'}x{/link}"],
    ['{link} with selectors', '{.c{$k} link "Go {$a}" "T"}x{/link}'],
    ['{button} label', '{button "Take {$item}"}{goto "T"}{/button}'],
    ['{button} label, single quotes', "{button 'Take {$item} {$a}'}x{/button}"],
    ['{dialog} label', '{dialog "Open {$item}"}Passage{/dialog}'],
    ['{print} string', '{print "Take {$item}"}'],
    ['{set} string', '{set _s = "Take {$item}"}'],
    ['{if} string', '{if _s == "{$item}"}x{/if}'],
    ['template literal code', '{print `Take ${$item}`}'],
    ['HTML attribute', '<a title="{$item}" href="#">x</a>'],
    ['HTML attribute and link', '<a title="{$a}">[[Go {$b}->T]]</a>'],
    ['transient in a button', '{button "{%t}"}x{/button}'],
    ['macro selector', '{.c{$k} print 1}'],
    ['unclosed brace in a label', '[[a {$item->T]] {set $y = 1}'],
  ];

  for (const [eolName, eol] of eols) {
    for (const [name, source] of fixtures) {
      it(`Q-differential ${name} (${eolName})`, () => {
        const text = source.replace(/\n/g, eol);
        expect(oursReads(text)).toEqual(oracleReads(text));
      });
    }
  }

  it('Q-differential-render: the link macro reads the token\'s label and name (the call path the oracle models)', () => {
    // the AST turns the link into `{link "label" "target"}`; the macro's
    // arguments are read as its declared parameters say (passagePieces)
    for (const text of ['[[Take {$item}->T]]', '[[Go->T{$n}]]', '[[Take {$item}]]', '[[a|{$x}]]']) {
      const real = runtimeBracketLink(text)!;
      expect(real.display).toBe(real.token.display);
      expect(real.passage).toBe(real.token.target);
      expect(real.display + real.passage).toMatch(/\{\$/);
    }
    expect(runtimeLinkMacro('"Take {$item}" "T{$n}"')).toEqual({ display: 'Take {$item}', passage: 'T{$n}' });
  });
});

describe('Q-diagnostic: SP305 flags {$x} where the link macro prints the braces', () => {
  const sp305 = (model: WorkspaceModel) => computeDiagnostics(uri, model).filter(d => d.code === 'SP305');

  const fixtures: Array<[string, string]> = [
    ['display', '[[Take {$item}->T]]'],
    ['target', '[[Go->T{$n}]]'],
    ['single text', '[[Take {$item}]]'],
    ['pipe form', '[[Take {$a}|T{$b}]]'],
    ['reverse form', '[[T{$b}<-Take {$a}]]'],
    ['transient', '[[{%t}->T]]'],
    ['local and temporary', '[[Take {_i} {@j}->T]]'],
    ['expression', '[[Hi {$a + $b}->T]]'],
    ['two blocks', '[[{$a} and {$b}->T]]'],
    ['{link} strings', '{link "Take {$item}" "T{$n}"}x{/link}'],
    ['{link} single quotes', "{link 'Take {$item}' 'T'}x{/link}"],
    ['plain link', '[[Take->T]]'],
    ['macro-looking label', '[[{if $x}label{/if}->T]]'],
    ['class selector only', '[[.c{$k} Go->T]]'],
    ['id selector only', '[[#i{$y} Go->T]]'],
    ['{link} without blocks', '{link "Take" "T"}x{/link}'],
    ['{button} label', '{button "Take {$item}"}{goto "T"}{/button}'],
    ['HTML attribute', '<a title="{$item}">x</a>'],
    ['{print} string', '{print "Take {$item}"}'],
    ['link in an attribute value', '<a title="[[Take {$item}->T]]">x</a>'],
    ['escaped brace', '[[Take \\{$item}->T]]'],
    ['unclosed block', '[[Take {$item->T]]'],
    ['no sigil', '[[Take {item}->T]]'],
    ['block across the separator', '[[{$a->b}->T]]'],
  ];

  /**
   * The runtime navigates to the name unchanged exactly where interpolate() would have changed it. (The label
   * is markup and is resolved: in 0.59 only the passage name is taken as written.)
   */
  function expected(text: string): number {
    let count = 0;
    for (const token of tokenize(text)) {
      if (token.type === 'link') {
        if (interpolates(token.target)) count += 1;
      } else if (token.type === 'macro' && !token.isClose && token.name === 'link') {
        const { passage } = runtimeLinkMacro(token.rawArgs);
        if (passage !== null && interpolates(passage)) count += 1;
      }
    }
    return count;
  }

  for (const [eolName, eol] of eols) {
    for (const [name, source] of fixtures) {
      it(`Q-diagnostic ${name} (${eolName})`, () => {
        const text = `:: StoryVariables${eol}$x = 1${eol}$item = 1${eol}$a = 1${eol}$b = 1${eol}$n = 1${eol}$k = 1${eol}$y = 1${eol}%t = 1${eol}:: Start${eol}${source.replace(/\n/g, eol)}${eol}:: T${eol}t${eol}`;
        const found = sp305(workspace(text));
        // One finding per block, with the block as its range
        const lineStarts = TextDocument.create(uri, 'twee', 0, text);
        for (const diagnostic of found) {
          const block = lineStarts.getText(diagnostic.range);
          expect(block).toMatch(/^\{[$_@%]\w/);
          expect(diagnostic.message).toContain(block);
          expect(diagnostic.severity).toBe('warning');
        }
        // Presence per link text agrees with the runtime reading, and a
        // text with no interpolate()-able block has none
        const blocks = found.length;
        const texts = expected(text.replace(/\r\n/g, '\n'));
        expect(blocks > 0).toBe(texts > 0);
        expect(blocks).toBeGreaterThanOrEqual(texts);
      });
    }
  }

  it('Q-diagnostic-messages: only the passage name a click navigates to is taken as written (the label is markup)', () => {
    const found = sp305(workspace(':: Start\n[[Take {$item}->T{$n}]]\n:: T{$n}\nx\n'));
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('the passage name a click navigates to contains it as written');
  });

  it('Q-diagnostic-ranges: each finding is exactly one block of the source', () => {
    const text = ':: Start\n[[A {$a} B {$b}->T {$n}]] {link "x {$x}" "T"}{/link}\n:: T\nx\n';
    const model = workspace(text);
    const blocks = sp305(model).map(d => TextDocument.create(uri, 'twee', 0, text).getText(d.range));
    expect(blocks).toEqual(['{$n}']);
  });

  it('Q-diagnostic-gating: only a passage name holds blocks as written, and a brace in a string does not end a block', () => {
    const found = findLiteralLinkInterpolations('[[A {$a}->T{$a + "}"}]] {link "q {$q}" "T{$q}"}x{/link}');
    expect(found.map(f => f.block)).toEqual(['{$a + "}"}', '{$q}']);
    expect(found.map(f => f.place)).toEqual(['link-target', 'link-macro-passage']);
  });

  it('Q-diagnostic-silent: other formats and non-markup passages', () => {
    const sugarcube = ':: StoryData\n{"format": "SugarCube"}\n:: Start\n[[Take {$item}->T]]\n';
    expect(sp305(workspace(sugarcube))).toEqual([]);
    expect(sp305(workspace(':: Start [script]\nvar s = "[[Take {$item}->T]]";\n'))).toEqual([]);
  });

  it('Q-diagnostic-selectors: only selector blocks are interpolated (range helper)', () => {
    const text = '[[.c{$k}#i{@j} Take {$item}->T{$n}]]';
    const [link] = findBracketLinks(text);
    expect(linkSelectorInterpolationRanges(text, link).map(([s, e]) => text.slice(s, e))).toEqual(['{$k}', '{@j}']);
    const token = tokenize(text)[0];
    expect(token).toMatchObject({ type: 'link', className: 'c{$k}', id: 'i{@j}' });
  });
});

describe('Q-rename: renaming a variable edits what is interpolated and nothing else', () => {
  for (const [eolName, eol] of eols) {
    const lines = (...rows: string[]) => rows.join(eol);
    const text = lines(
      ':: StoryVariables', '$x = 1', '$item = 2',
      ':: Start',
      '[[.k{$x} Take {$x}->T{$x}]]',
      '{link "Take {$x}" "T"}go{/link}',
      '{button "Take {$x}"}{goto "T"}{/button}',
      '<a title="{$x}">[[Go {$x}->T]]</a>',
      '{print "{$x}"} {print $x}',
      ':: T', 'end', '');

    it(`Q-rename-edits: selectors, link and button labels and attributes follow; passage names and strings do not (${eolName})`, () => {
      const model = workspace(text);
      const refs = findVariableReferences('x', model, false).map(r => `${r.range.start.line}:${r.range.start.character}`);
      // [[.k{$x} ...]] selector and label; {link} text; {button} label; <a title>; the label of the link in it; {print $x};
      // no passage name or {print "..."} string
      expect([...refs].sort()).toEqual(['4:15', '4:5', '5:13', '6:15', '7:11', '7:22', '8:22']);

      const edits = computeRename(uri, { line: 1, character: 1 }, 'y', model);
      const output = apply(text, edits.get(uri));
      expect(output).toBe(lines(
        ':: StoryVariables', '$y = 1', '$item = 2',
        ':: Start',
        '[[.k{$y} Take {$y}->T{$x}]]',
        '{link "Take {$y}" "T"}go{/link}',
        '{button "Take {$y}"}{goto "T"}{/button}',
        '<a title="{$y}">[[Go {$y}->T]]</a>',
        '{print "{$x}"} {print $y}',
        ':: T', 'end', ''));
    });

    it(`Q-rename-reparse: the runtime reads the same variables, renamed, after the edit (${eolName})`, () => {
      const model = workspace(text);
      const output = apply(text, computeRename(uri, { line: 1, character: 1 }, 'y', model).get(uri));
      const body = (source: string) => source.split(/\r?\n/).slice(4, 9).join('\n');
      const reads = (source: string, name: string) => tokenize(body(source)).flatMap(token => {
        if (token.type === 'link') return [token.className, token.id, token.display].flatMap(v => interpolationReads(v)).filter(n => n === `$${name}`);
        if (token.type === 'html') return Object.values(token.attributes).flatMap(v => interpolationReads(v)).filter(n => n === `$${name}`);
        if (token.type === 'macro' && token.name === 'button') return interpolationReads(token.rawArgs.replace(/^["']|["']$/g, '')).filter(n => n === `$${name}`);
        if (token.type === 'macro' && token.name === 'link') return interpolationReads(runtimeLinkMacro(token.rawArgs).display).filter(n => n === `$${name}`);
        return [];
      });
      expect(reads(output, 'y')).toEqual(reads(text, 'x').map(name => name.replace('x', 'y')));
      expect(reads(text, 'x')).toHaveLength(6);
      expect(reads(output, 'x')).toEqual([]);
      // The passage names, which the runtime takes as written, are untouched
      expect(tokenize(body(output)).filter(t => t.type === 'link').map(t => (t.type === 'link' ? t.target : '')))
        .toEqual(tokenize(body(text)).filter(t => t.type === 'link').map(t => (t.type === 'link' ? t.target : '')));
      // Rebuild from the edited text: the model agrees
      const rebuilt = workspace(output);
      expect(rebuilt.variables.getUsages('y')).toHaveLength(7);
      expect(rebuilt.variables.getUsages('x')).toHaveLength(0);
    });

    it(`Q-rename-lens: the reference count of the declaration is the usage count (${eolName})`, () => {
      const model = workspace(text);
      const lens = computeCodeLenses(uri, model).find(l => l.range.start.line === 1);
      expect(lens?.command?.title).toBe('7 usages');
    });
  }
});

describe('Q-validation: SP200 follows the installed startup validation', () => {
  const sources = [
    '[[Take {$nope}->T]]',
    '[[Go->T{$nope}]]',
    '[[.c{$nope} Go->T]]',
    '{link "Take {$nope}" "T"}x{/link}',
    '{button "Take {$nope}"}x{/button}',
    '{print "{$nope}"}',
    '<a title="{$nope}">x</a>',
    '[[Take {$decl}->T]]',
    'plain text with $nope and {$nope}',
  ];

  function lspUndeclared(content: string): string[] {
    const tracker = new VariableTracker();
    tracker.setCapabilities(INSTALLED_CAPABILITIES);
    tracker.parseStoryVariables('$decl = 1', 1, uri);
    tracker.scanDocument(uri, [':: StoryVariables', '$decl = 1', ':: Start', content, ''].join('\n'), []);
    return tracker.getUndeclared(uri).map(u => u.name).sort();
  }

  function runtimeUndeclared(content: string): string[] {
    const passages = new Map([['Start', { name: 'Start', tags: [], content } as never]]);
    const names = new Set(validatePassages(passages, parseStoryVariables('$decl = 1'))
      .map(e => /Undeclared variable: \$(\w+)/.exec(e)![1]));
    return [...names].sort();
  }

  for (const source of sources) {
    it(`Q-validation ${JSON.stringify(source)}`, () => {
      expect(lspUndeclared(source)).toEqual(runtimeUndeclared(source));
    });
  }

  it('Q-validation-versions: raw text before 0.50.1, the tokenizer after (link text included)', () => {
    const names = lspUndeclared('[[Take {$nope}->T]]');
    expect(names).toEqual(INSTALLED_CAPABILITIES.executableRefsOnly ? [] : ['nope']);
  });

  it('Q-validation-diagnostics: SP200 and SP305 are independent findings on the same link', () => {
    const model = workspace(':: StoryVariables\n$decl = 1\n:: Start\n[[Take->T{$nope}]]\n:: T\nx\n');
    const codes = computeDiagnostics(uri, model).map(d => d.code);
    expect(codes).toContain('SP305');
    expect(codes.includes('SP200')).toBe(!INSTALLED_CAPABILITIES.executableRefsOnly);
  });
});
