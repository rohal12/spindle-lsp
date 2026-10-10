/**
 * Macro heads against Spindle's tokenizer. The tokenizer takes the text
 * between a macro's braces whole: the name is everything up to the first
 * whitespace (after `/` for a closer, after the selectors and one space for
 * an opener, which starts with a letter). So `{a=b}`, `{if($x)}`, `{x{$y}}`
 * and `{/.cls if}` are macros, named `a=b`, `if($x)`, `x{$y}` and `.cls`
 * (and `{/}` / `{/ x}` close a macro named ``). The shared head grammar
 * (parseMacros) must agree for every name, and so must its consumers:
 * unknown-macro diagnostics (SP100/SP104), widget references, definition and
 * rename.
 *
 * Oracle: the installed runtime's tokenizer, through `tokenizeMarkupTolerant`
 * of the public tooling API. It skips string literals when it looks for the
 * closing brace (the plain counting of Spindle before 0.50.1 is gone from the
 * supported releases).
 */
import { describe, expect, it } from 'vitest';
import { tokenize as installedTokenize } from '../helpers/tooling.js';
import { buildLineStarts, macroHeadNameAt, macroHeadNames, parseMacros } from '../../src/core/parsing/macro-parser.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { findWidgetReferences } from '../../src/plugins/references.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { computeRename } from '../../src/plugins/rename.js';
import type { BraceReading } from '../../src/core/parsing/code-scanner.js';
import { INSTALLED_CAPABILITIES } from '../helpers/spindle-version.js';

type Tokenize = (text: string) => Array<{ type: string } & Record<string, unknown>>;

/** [start, name, isClose] of the macros the tokenizer reads. */
function oracle(tokenize: Tokenize, text: string): string[] {
  return tokenize(text)
    .filter(token => token.type === 'macro')
    .map(token => `${token.start as number}:${JSON.stringify(token.name)}:${token.isClose as boolean}`);
}

/** The macros the parser reads, counting braces as the release behind the oracle does. */
function ours(text: string, reading: BraceReading = INSTALLED_CAPABILITIES): string[] {
  const lineStarts = buildLineStarts(text);
  return parseMacros(text, reading).map(
    m => `${lineStarts[m.range.start.line] + m.range.start.character}:${JSON.stringify(m.name)}:${!m.open}`,
  );
}

function rng(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

const SELECTORS = ['', '/', '.c ', '#i.c ', '.c', '/ ', ' ', '.c  ', '.c{$k} ', '.c\n', '.a.b '];
const BASE_CHARS = ['a', 'b', '=', '+', '(', ')', ' ', '$', '_', '.', '#', '-', '1', '{', '}', '/', '\n', '\r\n', '\t', ',', '!', '@', '%', '[', ']', '<', '>', 'é', '\\', ';', ':', '*'];
const QUOTE_CHARS = ['"', "'", '`'];

/** `{` + selectors + name characters + `}`, with a second macro behind it. */
function head(random: () => number, chars: string[]): string {
  let body = '';
  for (let k = Math.floor(random() * 7); k > 0; k--) body += chars[Math.floor(random() * chars.length)];
  const letter = random() < 0.85 ? 'a' : '';
  return '{' + SELECTORS[Math.floor(random() * SELECTORS.length)] + letter + body + '}' + (random() < 0.3 ? '{/x}' : '');
}

describe('macro heads: every name the tokenizer reads is a macro (differential)', () => {
  it('H-installed: random heads agree with the installed tokenizer', () => {
    const random = rng(2026);
    let compared = 0;
    let withOddNames = 0;
    for (let n = 0; n < 60000; n++) {
      const text = head(random, BASE_CHARS);
      const expected = oracle(installedTokenize as unknown as Tokenize, text);
      expect(ours(text), JSON.stringify(text)).toEqual(expected);
      compared++;
      if (expected.some(m => /[^\w:"-]/.test(m.split(':').slice(1, -1).join(':').replace(/"/g, '')))) withOddNames++;
    }
    expect(compared).toBe(60000);
    expect(withOddNames).toBeGreaterThan(3000);
  });

  it('H-installed-quotes: heads with quotes and braces agree with the installed tokenizer, whichever release', () => {
    // Before 0.50.1 every brace counts, from it strings and templates are skipped
    const random = rng(52);
    let differing = 0;
    for (let n = 0; n < 60000; n++) {
      const text = head(random, [...BASE_CHARS, ...QUOTE_CHARS]);
      const expected = oracle(installedTokenize as unknown as Tokenize, text);
      expect(ours(text), JSON.stringify(text)).toEqual(expected);
      if (JSON.stringify(ours(text, { stringAwareBraces: !INSTALLED_CAPABILITIES.stringAwareBraces })) !== JSON.stringify(expected)) differing++;
    }
    // The inputs do tell the two readings apart (so this is not vacuous)
    expect(differing).toBeGreaterThan(10);
  });

  it('H-vendored: heads with quotes and braces agree with the string-aware tokenizer', () => {
    const random = rng(51);
    for (let n = 0; n < 60000; n++) {
      const text = head(random, [...BASE_CHARS, ...QUOTE_CHARS]);
      expect(ours(text, { stringAwareBraces: true }), JSON.stringify(text)).toEqual(oracle(installedTokenize as unknown as Tokenize, text));
    }
  });

  it('H-fragments: heads among prose, links, tags and other macros', () => {
    const fragments = ['{', '}', '/', 'a', 'b=c', '{a=b}', '{/x}', '{if $x}', '{/if}', ' ', '\n', '[[', ']]', '<p>', '</p>', '{$v}', '{.c x}', '\\{', '{x{$y}}', '{a+b c}', '{/ y}', '{/}', '{f(1)}', "{a'b c'd}"];
    const random = rng(7);
    for (let n = 0; n < 30000; n++) {
      let text = '';
      for (let k = 1 + Math.floor(random() * 8); k > 0; k--) text += fragments[Math.floor(random() * fragments.length)];
      expect(ours(text, { stringAwareBraces: true }), JSON.stringify(text)).toEqual(oracle(installedTokenize as unknown as Tokenize, text));
      expect(ours(text), JSON.stringify(text)).toEqual(oracle(installedTokenize as unknown as Tokenize, text));
    }
  });

  it('H-names: the names behind the examples', () => {
    for (const [text, names] of [
      ['{a=b}', ['a=b']],
      ['{a=b c}', ['a=b']],
      ['{if($x)}x{/if}', ['if($x)', 'if']],
      // the braces inside a head are matched (up to 0.51.3 the name ran to the last `}`)
      ['{x{$y}}', ['x{$y']],
      ['{.c a+b 1}', ['a+b']],
      // a closer takes no selectors, arguments or empty name any more: `{/` is text and the tokenizer reports it
      ['{/.cls if}', []],
      ['{/}', []],
      ['{/ x}', []],
      ['{a"b c}', ['a"b']],
      ['{a}{a=}', ['a', 'a=']],
    ] as Array<[string, string[]]>) {
      expect(parseMacros(text).map(m => m.name), text).toEqual(names);
      expect(tokenize_names(text), text).toEqual(names);
    }
  });
});

function tokenize_names(text: string): string[] {
  return installedTokenize(text).filter(t => t.type === 'macro').map(t => (t as unknown as { name: string }).name);
}

describe('macro heads: the consumers agree', () => {
  const uri = 'file:///story.tw';
  const eols = [['LF', '\n'], ['CRLF', '\r\n']] as const;

  function workspace(text: string): WorkspaceModel {
    const model = new WorkspaceModel();
    model.initialize(new Map([[uri, text]]));
    return model;
  }
  const sp = (model: WorkspaceModel, code: string) => computeDiagnostics(uri, model).filter(d => d.code === code);

  for (const [eolName, eol] of eols) {
    const lines = (...l: string[]) => l.join(eol);

    it(`H-sp100 (${eolName}): an unknown name the tokenizer reads is reported with its whole name`, () => {
      const text = lines(':: Start', '{a=b} {if($x)} {x{$y}} {a+b c}', '');
      const found = sp(workspace(text), 'SP100');
      expect(found.map(d => d.message)).toEqual([
        'Unrecognized macro: {a=b}',
        'Unrecognized macro: {if($x)}',
        'Unrecognized macro: {x{$y}}',
        'Unrecognized macro: {a+b}',
      ]);
      expect(found[0].range).toEqual({ start: { line: 1, character: 0 }, end: { line: 1, character: 5 } });
    });

    it(`H-sp104 (${eolName}): a closer for a macro that is no container is reported, whatever the name`, () => {
      const text = lines(':: Start', '{a=b}{/a=b}', '{/ x}', '{/set}');
      const found = sp(workspace(text), 'SP104');
      expect(found.map(d => d.message)).toEqual([
        'Illegal closing tag: {a=b} is not a container',
        'Illegal closing tag: {} is not a container',
        'Illegal closing tag: {set} is not a container',
      ]);
    });

    it(`H-controls (${eolName}): ordinary macros and variable displays are untouched`, () => {
      const text = lines(':: StoryVariables', '$x = 1', ':: Start', '{if $x}a{/if} {set $x = 2} {$x} {.c $x} {print $x} \\{a=b}', '');
      expect(sp(workspace(text), 'SP100')).toEqual([]);
      expect(sp(workspace(text), 'SP104')).toEqual([]);
    });

    it(`H-widget (${eolName}): a widget named a=b has references, definition and rename like any other`, () => {
      const text = lines(
        ':: Widgets [widget]', '{widget "a=b" @x}', '[{@x}]', '{/widget}',
        ':: Start', '{a=b 1} and {A=B 2}', '',
      );
      const model = workspace(text);
      expect(sp(model, 'SP100')).toEqual([]);
      const refs = findWidgetReferences('a=b', model, false);
      expect(refs.map(r => [r.range.start.line, r.range.start.character, r.range.end.character])).toEqual([[5, 1, 4], [5, 13, 16]]);
      expect(getDefinition(uri, { line: 5, character: 2 }, model)?.range.start.line).toBe(1);
      const head = macroHeadNameAt(text, { line: 5, character: 2 }, model.macroHeadPairing(uri));
      expect(head?.name).toBe('a=b');
      expect(macroHeadNames(text, model.macroHeadPairing(uri)).map(h => h.name)).toEqual(['widget', 'widget', 'a=b', 'A=B']);
      // rename: the definition and both calls
      const edits = computeRename(uri, { line: 5, character: 2 }, 'cover', model).get(uri) ?? [];
      expect(edits.map(e => [e.range.start.line, e.range.start.character]).sort((a, b) => a[0] - b[0] || a[1] - b[1]))
        .toEqual([[1, 9], [5, 1], [5, 13]]);
    });
  }
});
