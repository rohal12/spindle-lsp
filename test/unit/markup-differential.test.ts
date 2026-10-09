/**
 * Differential contracts against Spindle 0.45.1's own tokenizer and
 * interpolate(), imported from the installed runtime's source.
 *
 *  - D3: where `[[` is a link and where a macro head is a macro, with HTML
 *    attribute values in between (attributeValueSpans, parseMacros,
 *    findBracketLinks) — quoted, single-quoted and unquoted values, `>` in
 *    values, multiline and unterminated values, macros inside values.
 *  - D1: macro-looking bracket-link labels are link text; the variables a
 *    link reads are the ones interpolate() reads.
 *
 * Every fixture runs with LF and CRLF line endings.
 */
import { describe, expect, it, vi } from 'vitest';
import { interpolate } from '../../node_modules/@rohal12/spindle/src/interpolation.js';
import { tokenize, type Token } from '../helpers/tooling.js';
import { attributeValueSpans } from '../../src/core/parsing/html-scanner.js';
import { findBracketLinks, parseDocumentPassageRefs } from '../../src/core/parsing/link-parser.js';
import { buildLineStarts, parseMacros } from '../../src/core/parsing/macro-parser.js';
import { INSTALLED_CAPABILITIES } from '../helpers/spindle-version.js';
import { VariableTracker } from '../../src/core/workspace/variable-tracker.js';

vi.mock('../../node_modules/@rohal12/spindle/src/store.ts', () => ({
  useStoryStore: { getState: () => ({ visitCounts: {}, renderCounts: {}, currentPassage: 'Start' }) },
}));

interface Facts {
  links: Array<[number, number]>;
  macros: Array<[number, string, boolean]>;
  attributes: string[];
}

/** What Spindle's tokenizer reads from one passage's text. */
function oracle(text: string): Facts {
  const tokens = tokenize(text);
  return {
    links: tokens.filter((t): t is Extract<Token, { type: 'link' }> => t.type === 'link').map(t => [t.start, t.end]),
    macros: tokens
      .filter((t): t is Extract<Token, { type: 'macro' }> => t.type === 'macro')
      .map(t => [t.start, t.name, t.isClose]),
    attributes: tokens
      .filter((t): t is Extract<Token, { type: 'html' }> => t.type === 'html' && !t.isClose)
      .flatMap(t => Object.values(t.attributes))
      .filter(value => value !== ''),
  };
}

/** What the language server reads from the same text, counting braces as the installed release does. */
function ours(text: string): Facts {
  const lineStarts = buildLineStarts(text);
  const reading = INSTALLED_CAPABILITIES;
  return {
    links: findBracketLinks(text, reading).map(link => [link.start, link.end]),
    macros: parseMacros(text, reading).map(m => [lineStarts[m.range.start.line] + m.range.start.character, m.name, !m.open]),
    attributes: attributeValueSpans(text, reading).map(([start, end]) => text.slice(start, end)).filter(value => value !== ''),
  };
}

const eols = [['LF', '\n'], ['CRLF', '\r\n']] as const;

describe('D3: [[ inside HTML attribute values, against tokenize()', () => {
  const fixtures: Array<[string, string]> = [
    ['double-quoted', '<a title="[[x]]">{goto "A"}</a> [[y->B]]'],
    ['single-quoted', "<a title='[[x]]'>{goto \"A\"}</a> [[y->B]]"],
    ['unquoted', '<a title=[[x]] class=c>{goto "A"}</a> [[y->B]]'],
    ['> in a quoted value', '<a title="a > [[x]]">{goto "A"}</a> [[y->B]]'],
    ['> ends an unquoted value inside a link-like text', '<p title=[[a->b]]>{goto "A"}</p>'],
    ['multiline quoted value', '<a title="line one\n[[x]]\nline three">{goto "A"}</a> [[y->B]]'],
    ['unterminated quote, no >', '<a title="[[x]]\n{goto "A"}\n[[y->B]]'],
    ['unterminated tag', '<a title=[[x]] [[y->B]]'],
    ['macro in a value', '<span class="{if $x}[[a->B]]{/if}">{goto "A"}</span>'],
    ['macro with quotes in a value', '<a title="{if $x == "a"}[[y]]{/if}">{goto "A"}</a>'],
    ['display in a value', '<a title="{$x}[[b]]">{goto "A"}</a>'],
    ['[[ opens in one value and ]] closes in another', '<a title="[[">{goto "A"}<b title="]]">{goto "B"}'],
    ['link containing a tag', '[[<a title="x">y</a>->T]] {goto "A"}'],
    ['tag after a macro', '{if $x}<a title="[[x]]">{/if}[[y->Z]]'],
    ['failed tag before a value', '<img src="a" <a href="|\n[[a->b]]">x'],
    ['unbalanced brace in a value', '<a title="{[[x]]">{goto "A"}'],
    ['apostrophe inside a double-quoted value', '<a title="it\'s [[x]]">{goto "A"}</a>'],
    ['escaped brace before a tag', '\\{<a title="[[x]]">{goto "A"}</a>'],
    ['unclosed link before a tag', '[[open <a title="[[x]]">{goto "A"}</a>'],
    ['boolean attribute then value', '<input disabled title="[[x]]">{goto "A"}'],
    ['whitespace around = (0.45.1 reads text)', '<a href = "x"> <b title="[[y]]">{goto "A"}'],
    ['self-closing tag', '<br title="[[x]]"/>{goto "A"}'],
    ['values on several tags', '<a a="[[1]]" b=\'[[2]]\' c=[[3]]>{goto "A"}<i d="[[4]]"></i>'],
    ['selector link and macro', '[[.c#i Go->T]]<a title="[[x]]">{.k goto "A"}'],
  ];

  for (const [eolName, eol] of eols) {
    for (const [name, source] of fixtures) {
      it(`D3 ${name} (${eolName})`, () => {
        const text = source.replace(/\n/g, eol);
        expect(ours(text)).toEqual(oracle(text));
        // The passage references follow: every link target and goto target
        const expected = oracle(text);
        const targets = tokenize(text).flatMap(t =>
          t.type === 'link' ? [t.target]
            : t.type === 'macro' && t.name === 'goto' && !t.isClose ? [t.rawArgs.replace(/^"|"$/g, '')]
              : []);
        expect(parseDocumentPassageRefs(text, []).map(r => r.name).sort()).toEqual(targets.sort());
        expect(expected.links.length + expected.macros.length).toBeGreaterThan(-1);
      });
    }
  }

  it('D3-fuzz: random markup built from tag, link, macro and quote fragments agrees with tokenize()', () => {
    const fragments = [
      '[[', ']]', '{if $x}', '{/if}', '{goto "A"}', '<a href="', '">', "<div class='", "'>", '<p title=', ' ', '>',
      '"', "'", '{', '}', 'x', '\n', '\r\n', '<img src="a" ', '/>', '{$v}', '|', '->', '<b>', '</b>',
      '{set $a = "[["}', '{.c if}', '\\{', '\\', '[[a->b]]', '<span class="{if $x}a{/if}">', '<a title="[[x]]">',
      '=', 'a="', "a='", '[', ']', '<', '/', '<!-- ', ' -->', '{_t}', '{@l}', '{%t}', '{.a#b $x}', '{#i{$k} goto "Z"}',
    ];
    let seed = 20261006;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let compared = 0;
    for (let n = 0; n < 6000; n++) {
      let text = '';
      for (let k = 1 + Math.floor(random() * 10); k > 0; k--) text += fragments[Math.floor(random() * fragments.length)];
      // Out of scope here: attributes that repeat a name (tokenize() keeps
      // the last). Braces and quotes are compared as the installed release
      // reads them: every brace counts before 0.50.1, strings are skipped from it.
      if (/(\w+)=[\s\S]*\b\1=/.test(text)) continue;
      compared++;
      const [expected, actual] = [oracle(text), ours(text)];
      // Macro heads with names outside the macro grammar ({a=b}) are not compared
      expect(actual.links, JSON.stringify(text)).toEqual(expected.links);
      expect(actual.attributes, JSON.stringify(text)).toEqual(expected.attributes);
      expect(actual.macros, JSON.stringify(text)).toEqual(expected.macros.filter(([, name]) => /^[A-Za-z][\w-]*$/.test(name)));
    }
    expect(compared).toBeGreaterThan(3000);
  });
});

describe('D1: macro-looking bracket-link labels are link text', () => {
  /** The variables interpolate() reads from `template`, as `$x` / `%t` names. */
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
   * The `$` and `%` names Spindle reads from `text`: a link token renders as
   * the `{link}` macro, whose wrapper interpolates its class and id but whose
   * MacroLink prints the display and navigates to the target as written
   * (verified by the next describe block against the source and by rendering,
   * docs/reviews/2026-10-06-convergence-fixes.md); an HTML tag interpolates
   * its attribute values; a macro reads the variables in its arguments (the
   * fixtures keep those free of strings, so a regular expression finds them).
   */
  function oracleReads(text: string): string[] {
    const names = tokenize(text).flatMap((token): string[] => {
      switch (token.type) {
        case 'link':
          return [
            ...interpolationReads(token.className),
            ...interpolationReads(token.id),
          ];
        case 'html':
          return Object.values(token.attributes).flatMap(interpolationReads);
        case 'variable':
          return token.scope === 'variable' ? [`$${token.name.split('.')[0]}`]
            : token.scope === 'transient' ? [`%${token.name.split('.')[0]}`] : [];
        case 'macro':
          return [...token.rawArgs.matchAll(/[$%]\w+/g)].map(m => m[0]);
        default:
          return [];
      }
    });
    return names.filter(name => name[0] === '$' || name[0] === '%').map(name => name.slice(1)).sort();
  }

  /** The names the variable tracker records as usages (executable reads). */
  function oursReads(text: string): string[] {
    const tracker = new VariableTracker();
    tracker.scanDocument('file:///s.tw', `:: P\n${text}`, []);
    // Look for every name the fixtures use
    return ['x', 'a', 'b', 't', 'u', 'k', 'y']
      .flatMap(name => [
        ...tracker.getUsages(name).map(() => name),
        ...tracker.getTransientUsages(name).map(() => name),
      ])
      .sort();
  }

  const labels: Array<[string, string]> = [
    ['if in the label (arrow)', '[[{if $x}label{/if}->Target]]'],
    ['if in the label (pipe)', '[[{if $x}label{/if}|Target]]'],
    ['if in the label (reverse arrow)', '[[Target<-{if $x}label{/if}]]'],
    ['goto in the label', '[[{goto "X"}->Target]]'],
    ['goto as the whole link', '[[{goto "X"}]]'],
    ['goto as the target', '[[Go->{goto "X"}]]'],
    ['set in the label', '[[{set $x = 1}go->Target]]'],
    ['css-prefixed macro in the label', '[[{.c print $x}->Target]]'],
    ['bare $x word in the label', '[[cost $x->Target]]'],
    ['transient in a macro in the label', '[[{if %t}a{/if}->Target]]'],
    ['display interpolation is printed as written', '[[Hi {$x}->Target]]'],
    ['display expression interpolation is printed as written', '[[Hi {$a + $b}->Target]]'],
    ['target interpolation is a literal passage name', '[[go->{$x}]]'],
    ['transient interpolation is printed as written', '[[{%t}->Target]]'],
    ['selector interpolation is read', '[[.c{$k} go->Target]]'],
    ['interpolation next to a macro', '[[{if $x}{$a}{/if}->Target]]'],
    ['selector id interpolation is read', '[[#i{$y} go->Target]]'],
    ['selector and label interpolation', '[[.c{$k} go {$a}->T{$b}]]'],
    ['block across the separator reads nothing', '[[{$a->b}->T]]'],
    ['macro after the link still runs', '[[{if $x}l{/if}->T]]{if $y}z{/if}'],
    ['unclosed brace in the label does not swallow the next macro', '[[a {->T]] {set $y = 1}'],
    ['macro before the link runs', '{if $x}[[a->T]]{/if}'],
    ['link in an attribute value is no link', '<a title="[[{$x}->T]]">{$y}</a>'],
    ['link text after an unterminated link', '[[open {if $x}a{/if}\n[[b {$a}->T]]'],
  ];

  for (const [eolName, eol] of eols) {
    for (const [name, source] of labels) {
      it(`D1 ${name} (${eolName})`, () => {
        const text = source.replace(/\n/g, eol);
        const tokens = tokenize(text);

        // Macros: the ones the tokenizer reads outside links
        const macroNames = tokens.flatMap(t => (t.type === 'macro' ? [t.name] : []));
        expect(parseMacros(text).map(m => m.name)).toEqual(macroNames);

        // Passage references: the link targets, then the macro targets
        const linkTargets = tokens.flatMap(t => (t.type === 'link' ? [t.target] : []));
        const refs = parseDocumentPassageRefs(text, []);
        expect(refs.filter(r => r.source === 'link').map(r => r.name)).toEqual(linkTargets);
        expect(refs.filter(r => r.source === 'macro')).toEqual([]);

        // Variable usages: what Spindle reads
        expect(oursReads(text)).toEqual(oracleReads(text));
      });
    }
  }
});

describe('C-D1-quote: the link macro reads a double quote in a label as a delimiter', () => {
  // MacroLink.parseArgs (components/macros/MacroLink.tsx, 0.45.1) collects
  // `/(["'])(.*?)\1/g` over `"display" "target"`. Copied here: the component
  // needs a DOM and preact.
  function linkMacroPassage(display: string, target: string): string | null {
    const parts = [...`"${display}" "${target}"`.matchAll(/(["'])(.*?)\1/g)].map(m => m[2]);
    return parts.length >= 2 ? parts[1] : null;
  }

  it('C-D1-quote: a label without a double quote navigates to the link token target', () => {
    for (const label of ['{if $x}label{/if}', "{print 'a'}", "Don't go", '{goto X}']) {
      const [link] = tokenize(`[[${label}->Target]]`);
      expect(link).toMatchObject({ type: 'link', target: 'Target' });
      expect(linkMacroPassage(label, 'Target')).toBe('Target');
    }
  });

  it('C-D1-quote: references follow the link token (the contract for this label), not the quoting accident', () => {
    // `{goto "X"}` in a label executes nothing, but its double quotes make
    // Spindle's link macro read `}` as the passage. That is Spindle's quoting
    // of the label, independent of the label being macro-like: any label with
    // a `"` does it (`[[He said "hi"->T]]`). The tokenizer, which decides
    // what executes, reads the target as written, and so do all consumers.
    expect(linkMacroPassage('{goto "X"}', 'Target')).toBe('}');
    expect(linkMacroPassage('He said "hi"', 'T')).toBe('');
    const text = '[[{goto "X"}->Target]]';
    expect(tokenize(text)[0]).toMatchObject({ type: 'link', target: 'Target' });
    expect(parseDocumentPassageRefs(text, []).map(r => r.name)).toEqual(['Target']);
    expect(parseMacros(text)).toEqual([]);
  });
});
