/**
 * Contract Q-link-interp: what Spindle interpolates in a link, and every
 * consumer of that fact.
 *
 * Runtime truth (every release from 0.43.0; rendered through tokenize,
 * buildAST and renderNodes in a DOM, see scripts/runtime-render.mjs and
 * docs/reviews/2026-10-06-convergence-fixes.md): `[[Take {$item}->T]]`
 * renders `Take {$item}` and `[[Go->T{$n}]]` navigates to a passage named
 * `T{$n}`. The link macro (MacroLink) prints and navigates to its text as
 * written. What is interpolated: the link's `.class#id` selectors (the macro
 * wrapper resolves className and id when the macro is defined with
 * `interpolate: true`), HTML attribute values, and the label of `{button}` and
 * `{dialog}` (they call `ctx.resolve`). A string in any other macro's
 * arguments is JavaScript, not a template.
 *
 * Q-source pins that reading to the installed runtime's source;
 * Q-differential compares the variable usages the LSP records with what the
 * runtime's own interpolate() reads; Q-diagnostic covers SP305; Q-rename
 * applies the rename edits and reparses; Q-validation compares SP200 with
 * the installed startup validation (raw text before 0.50.1, executable
 * references from it). Every case runs with LF and CRLF.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { interpolate } from '../../node_modules/@rohal12/spindle/src/interpolation.js';
import { tokenize } from '../helpers/tooling.js';
import { parseStoryVariables, validatePassages } from '../../node_modules/@rohal12/spindle/src/story-variables.js';
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

// interpolate() reaches the store through expression.ts; the store needs a DOM framework
vi.mock('../../node_modules/@rohal12/spindle/src/store.ts', () => ({
  useStoryStore: { getState: () => ({ visitCounts: {}, renderCounts: {}, currentPassage: 'Start' }) },
}));

const spindle = join(process.cwd(), 'node_modules/@rohal12/spindle');
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
  const macroFiles = readdirSync(join(spindle, 'src/components/macros')).filter(name => name.endsWith('.tsx'));
  const read = (name: string) => readFileSync(join(spindle, 'src/components/macros', name), 'utf-8');
  const macroName = (source: string) => /defineMacro\(\{\s*name: '([^']+)'/.exec(source)?.[1];

  it('Q-source-link: MacroLink never resolves its text, only the wrapper resolves class and id', () => {
    const link = read('MacroLink.tsx');
    expect(macroName(link)).toBe('link');
    expect(link).toMatch(/interpolate: true/);
    // The display and the passage come out of parseArgs and are used as written
    expect(link.slice(link.indexOf('defineMacro('))).not.toMatch(/resolve|interpolat(?!e: true)/);
    const wrapper = readFileSync(join(spindle, 'src/define-macro.ts'), 'utf-8');
    const block = /if \(config\.interpolate\) \{([\s\S]*?)\n    \}/.exec(wrapper)?.[1] ?? '';
    expect(block).toMatch(/resolve = useInterpolate\(\)/);
    expect(block).toMatch(/className = resolve\(className\)/);
    expect(block).toMatch(/id = resolve\(id\)/);
    expect(block.replace(/\/\/.*$/gm, '').split('\n').filter(line => line.trim()).length).toBe(3);
  });

  it('Q-source-args: only {button} and {dialog} resolve their arguments; {if} and {timed} resolve section selectors', () => {
    const resolvers = macroFiles
      .filter(file => /ctx\.resolve/.test(read(file)))
      .map(file => `${macroName(read(file))}:${/ctx\.resolve[!?]*\.?\(?(?:rawArgs|labelRaw)/.test(read(file)) || /resolve\?\.\((?:rawArgs|labelRaw)/.test(read(file)) ? 'args' : 'selectors'}`)
      .sort();
    expect(resolvers).toEqual(['button:args', 'dialog:args', 'if:selectors', 'timed:selectors']);
  });

  it('Q-source-registry: every built-in macro is classified (a new one forces a decision)', () => {
    const registry = JSON.parse(readFileSync(join(spindle, 'dist/pkg/macro-registry.json'), 'utf-8')) as Array<{ name: string }>;
    const classified = new Set([...LITERAL_ARGUMENT_MACROS, 'button', 'dialog']);
    expect(registry.map(m => m.name).filter(name => !classified.has(name))).toEqual([]);
    // and the literal list holds nothing the runtime does not ship
    const shipped = new Set(registry.map(m => m.name));
    expect([...LITERAL_ARGUMENT_MACROS].filter(name => !shipped.has(name))).toEqual([]);
  });
});

/** Names read by interpolate(), as `$x` / `%t`. */
function interpolationReads(template: string | undefined): string[] {
  if (template === undefined) return [];
  const seen: string[] = [];
  const scope = (prefix: string) => new Proxy({}, {
    get: (_target, key) => {
      if (typeof key === 'string') seen.push(prefix + key);
      return undefined;
    },
    has: () => true,
  });
  try {
    interpolate(template, scope('$') as never, scope('_') as never, scope('@') as never, scope('%') as never);
  } catch {
    // An expression that does not parse reads nothing
  }
  return seen;
}

/**
 * The `$` and `%` names a macro's arguments read as code: outside ordinary
 * strings (literal text), and inside the `${…}` parts of template literals.
 */
function codeReads(rawArgs: string): string[] {
  const reads: string[] = [];
  const code = rawArgs.replace(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g, (_whole, quote: string, body: string) => {
    if (quote === '`') for (const part of body.matchAll(/\$\{([^}]*)\}/g)) reads.push(...part[1].matchAll(/[$%]\w+/g).map(m => m[0]));
    return ' ';
  });
  return [...reads, ...[...code.matchAll(/[$%]\w+/g)].map(m => m[0])];
}

/** Whether interpolate() would change `template` (it evaluates some block in it). */
function interpolates(template: string): boolean {
  const value = new Proxy({}, { get: (_t, key) => (typeof key === 'string' ? 'V' : undefined), has: () => true });
  try {
    return interpolate(template, value as never, value as never, value as never, value as never) !== template;
  } catch {
    return true;
  }
}

describe('Q-differential: variable usages are what the runtime interpolates', () => {
  /** `$` and `%` names the runtime reads from the passage markup, per the render path. */
  function oracleReads(text: string): string[] {
    const names = tokenize(text).flatMap((token): string[] => {
      switch (token.type) {
        case 'link':
          // the {link} macro: class and id resolved, text as written
          return [...interpolationReads(token.className), ...interpolationReads(token.id)];
        case 'html':
          return Object.values(token.attributes).flatMap(interpolationReads);
        case 'variable':
          return token.scope === 'variable' ? [`$${token.name.split('.')[0]}`]
            : token.scope === 'transient' ? [`%${token.name.split('.')[0]}`] : [];
        case 'macro': {
          if (token.isClose) return [];
          // {button} and {dialog} interpolate their label; no other macro interpolates a string
          const label = token.name === 'button' ? token.rawArgs.replace(/^["']|["']$/g, '')
            : token.name === 'dialog' ? token.rawArgs.replace(/\bnoclose\s*$/, '').trim().replace(/^["']|["']$/g, '')
              : undefined;
          return [
            ...interpolationReads(label),
            ...interpolationReads(token.className),
            ...interpolationReads(token.id),
            ...codeReads(token.rawArgs),
          ];
        }
        default:
          return [];
      }
    });
    return names.filter(name => name[0] === '$' || name[0] === '%').map(name => name.slice(1)).sort();
  }

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

  it('Q-differential-render: a link renders its text as written (the call path the oracle models)', () => {
    // buildAST turns the link into the `link` macro; its arguments are read by
    // MacroLink.parseArgs (the real function, from the installed source)
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

  /** The runtime prints (or navigates to) the text unchanged exactly where interpolate() would have changed it. */
  function expected(text: string): number {
    let count = 0;
    for (const token of tokenize(text)) {
      if (token.type === 'link') {
        // `[[x]]` has one text, shown and navigated to
        if (token.display === token.target) {
          if (interpolates(token.display)) count += 1;
        } else {
          if (interpolates(token.display)) count += 1;
          if (interpolates(token.target)) count += 1;
        }
      } else if (token.type === 'macro' && !token.isClose && token.name === 'link') {
        const strings = [...token.rawArgs.matchAll(/(["'])(.*?)\1/g)].slice(0, 2).map(m => m[2]);
        for (const text of strings) if (interpolates(text)) count += 1;
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

  it('Q-diagnostic-messages: the label and the target are told apart, with the alternative', () => {
    const found = sp305(workspace(':: Start\n[[Take {$item}->T{$n}]]\n:: T{$n}\nx\n'));
    expect(found).toHaveLength(2);
    expect(found[0].message).toContain('the label shown contains it as written');
    expect(found[1].message).toContain('the passage name a click navigates to contains it as written');
    expect(found[0].message).toContain('{button "Take {$item}"}{goto "Passage"}{/button}');
  });

  it('Q-diagnostic-ranges: each finding is exactly one block of the source', () => {
    const text = ':: Start\n[[A {$a} B {$b}->T {$n}]] {link "x {$x}" "T"}{/link}\n:: T\nx\n';
    const model = workspace(text);
    const blocks = sp305(model).map(d => TextDocument.create(uri, 'twee', 0, text).getText(d.range));
    expect(blocks).toEqual(['{$a}', '{$b}', '{$n}', '{$x}']);
  });

  it('Q-diagnostic-gating: the same on every release, with either brace reading', () => {
    for (const stringAwareBraces of [false, true]) {
      const found = findLiteralLinkInterpolations('[[A {$a + "}"}->T]] {link "q {$q}" "T"}x{/link}', { stringAwareBraces });
      expect(found.map(f => f.block)).toEqual(stringAwareBraces ? ['{$a + "}"}', '{$q}'] : ['{$a + "}', '{$q}']);
    }
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

    it(`Q-rename-edits: selectors, button labels and attributes follow; link text and strings do not (${eolName})`, () => {
      const model = workspace(text);
      const refs = findVariableReferences('x', model, false).map(r => `${r.range.start.line}:${r.range.start.character}`);
      // [[.k{$x} ...]] selector; {button} label; <a title>; {print $x}; no label/target/{link}/{print "..."} string
      expect([...refs].sort()).toEqual(['4:5', '6:15', '7:11', '8:22']);

      const edits = computeRename(uri, { line: 1, character: 1 }, 'y', model);
      const output = apply(text, edits.get(uri));
      expect(output).toBe(lines(
        ':: StoryVariables', '$y = 1', '$item = 2',
        ':: Start',
        '[[.k{$y} Take {$x}->T{$x}]]',
        '{link "Take {$x}" "T"}go{/link}',
        '{button "Take {$y}"}{goto "T"}{/button}',
        '<a title="{$y}">[[Go {$x}->T]]</a>',
        '{print "{$x}"} {print $y}',
        ':: T', 'end', ''));
    });

    it(`Q-rename-reparse: the runtime reads the same variables, renamed, after the edit (${eolName})`, () => {
      const model = workspace(text);
      const output = apply(text, computeRename(uri, { line: 1, character: 1 }, 'y', model).get(uri));
      const body = (source: string) => source.split(/\r?\n/).slice(4, 9).join('\n');
      const reads = (source: string, name: string) => tokenize(body(source)).flatMap(token => {
        if (token.type === 'link') return [token.className, token.id].flatMap(v => interpolationReads(v)).filter(n => n === `$${name}`);
        if (token.type === 'html') return Object.values(token.attributes).flatMap(v => interpolationReads(v)).filter(n => n === `$${name}`);
        if (token.type === 'macro' && token.name === 'button') return interpolationReads(token.rawArgs.replace(/^["']|["']$/g, '')).filter(n => n === `$${name}`);
        return [];
      });
      expect(reads(output, 'y')).toEqual(reads(text, 'x').map(name => name.replace('x', 'y')));
      expect(reads(text, 'x')).toHaveLength(3);
      expect(reads(output, 'x')).toEqual([]);
      // The link text, which the runtime prints as written, is untouched
      expect(tokenize(body(output)).filter(t => t.type === 'link').map(t => (t.type === 'link' ? [t.display, t.target] : [])))
        .toEqual(tokenize(body(text)).filter(t => t.type === 'link').map(t => (t.type === 'link' ? [t.display, t.target] : [])));
      // Rebuild from the edited text: the model agrees
      const rebuilt = workspace(output);
      expect(rebuilt.variables.getUsages('y')).toHaveLength(4);
      expect(rebuilt.variables.getUsages('x')).toHaveLength(0);
    });

    it(`Q-rename-lens: the reference count of the declaration is the usage count (${eolName})`, () => {
      const model = workspace(text);
      const lens = computeCodeLenses(uri, model).find(l => l.range.start.line === 1);
      expect(lens?.command?.title).toBe('4 usages');
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
    const model = workspace(':: StoryVariables\n$decl = 1\n:: Start\n[[Take {$nope}->T]]\n:: T\nx\n');
    const codes = computeDiagnostics(uri, model).map(d => d.code);
    expect(codes).toContain('SP305');
    expect(codes.includes('SP200')).toBe(!INSTALLED_CAPABILITIES.executableRefsOnly);
  });
});
