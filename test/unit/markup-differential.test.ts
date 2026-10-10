/**
 * Differential contracts against Spindle's own tokenizer and passage reading
 * (the public tooling API), and the closest public equivalent of its
 * interpolate() (test/helpers/interpolation-oracle.ts).
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
import { describe, expect, it } from 'vitest';
import { collectStoryPassageReferences } from '@rohal12/spindle/tooling';
import { builtinMacros, deepTokens, tokenize, type Token } from '../helpers/tooling.js';
import { runtimeBracketLink } from '../helpers/link-macro-oracle.js';
import { runtimeVariableReads } from '../helpers/variable-reads-oracle.js';
import { attributeValueSpans } from '../../src/core/parsing/html-scanner.js';
import { findBracketLinks } from '../../src/core/parsing/link-parser.js';
import { documentPassageRefs } from '../../src/core/markup/passage-refs.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { buildLineStarts, parseMacros } from '../../src/core/parsing/macro-parser.js';
import { INSTALLED_CAPABILITIES } from '../helpers/spindle-version.js';
import { VariableTracker } from '../../src/core/workspace/variable-tracker.js';

/** The passage names written out in `text`, read as the body of a passage. */
function passageRefsOf(text: string) {
  const model = new WorkspaceModel();
  model.initialize(new Map([['file:///s.tw', `:: P\n${text}`]]));
  const refs = documentPassageRefs(model.markup.get('file:///s.tw')!);
  model.dispose();
  return refs;
}

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
    // Spindle 0.59 reads the markup in link labels and attribute values too: its macros are macros
    macros: deepTokens(text)
      .map(({ token }) => token)
      .filter((t): t is Extract<Token, { type: 'macro' }> => t.type === 'macro')
      .sort((a, b) => a.start - b.start)
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
      it(`D3-refs ${name} (${eolName})`, () => {
        const text = source.replace(/\n/g, eol);
        // The passage references follow the tokenizer: every link target and goto target
        const targets = collectStoryPassageReferences(text.replace(/\r\n/g, '\n'), builtinMacros)
          .flatMap(ref => (ref.target.kind === 'name' ? [ref.target.name] : []));
        expect(passageRefsOf(text).map(r => r.name).sort()).toEqual(targets.sort());
      });

      it(`D3 ${name} (${eolName})`, () => {
        const text = source.replace(/\n/g, eol);
        expect(ours(text)).toEqual(oracle(text));
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

describe('D1: macros in bracket-link labels are macros (a label holds markup)', () => {
  /**
   * The `$` and `%` names Spindle reads from `text` (test/helpers/variable-reads-oracle.ts): a link token
   * renders as the `{link}` macro, whose label is markup (resolved) and whose wrapper interpolates class
   * and id; an HTML tag resolves its attribute values as markup; a macro reads the variables in its arguments.
   */
  const oracleReads = runtimeVariableReads;

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
      it(`D1-refs ${name} (${eolName})`, () => {
        const text = source.replace(/\n/g, eol);
        // Passage references: the link targets, then the macro targets (the label's included)
        const linkTargets = tokenize(text).flatMap(t => (t.type === 'link' ? [t.target] : []));
        const refs = passageRefsOf(text);
        expect(refs.filter(r => r.form === 'bracket').map(r => r.name)).toEqual(linkTargets);
        const macroTargets = collectStoryPassageReferences(text.replace(/\r\n/g, '\n'), builtinMacros)
          .flatMap(ref => (ref.macro !== 'link' && ref.target.kind === 'name' ? [ref.target.name] : []));
        expect(refs.filter(r => r.macro !== 'link').map(r => r.name)).toEqual(macroTargets);
      });

      it(`D1 ${name} (${eolName})`, () => {
        const text = source.replace(/\n/g, eol);

        // Macros: the ones the tokenizer reads, including those in link labels (markup of their own)
        const macroNames = deepTokens(text).flatMap(({ token }) => (token.type === 'macro' ? [token] : []))
          .sort((a, b) => a.start - b.start).map(t => t.name);
        expect(parseMacros(text).map(m => m.name)).toEqual(macroNames);

        // Variable usages: what Spindle reads
        expect(oursReads(text)).toEqual(oracleReads(text));
      });
    }
  }
});

describe('C-D1-quote: the link macro reads its arguments as JavaScript string literals', () => {
  // Spindle 0.59 reads `{link "label" "passage"}` with the macro's declared parameters (`text`: a quoted string
  // holding markup, `passage`: a name read as a JavaScript literal), not with the regular expression
  // `/(["'])(.*?)\1/g` that 0.45.1's MacroLink.parseArgs collected quoted parts with.
  it('C-D1-quote: a label without a double quote navigates to the link token target', () => {
    for (const label of ['{if $x}label{/if}', "{print 'a'}", "Don't go", '{goto X}']) {
      const [link] = tokenize(`[[${label}->Target]]`);
      expect(link).toMatchObject({ type: 'link', target: 'Target' });
      expect(runtimeBracketLink(`[[${label}->Target]]`)?.passage).toBe('Target');
    }
  });

  it('C-D1-quote: references follow the link token for every label, quotes included', () => {
    // A `"` in a label used to make the link macro read `}` or '' as the passage; the label is now escaped
    // into a string literal and the passage is the token's target whatever the label holds.
    expect(runtimeBracketLink('[[{goto "X"}->Target]]')?.passage).toBe('Target');
    expect(runtimeBracketLink('[[He said "hi"->T]]')?.passage).toBe('T');
    const text = '[[{goto "X"}->Target]]';
    expect(tokenize(text)[0]).toMatchObject({ type: 'link', target: 'Target' });
    // the {goto "X"} in the label is markup of its own, so it is a macro and a reference too
    expect(passageRefsOf(text).map(r => r.name).sort()).toEqual(['Target', 'X']);
  });

  it('C-D1-quote: the macro in the label is a macro', () => {
    expect(parseMacros('[[{goto "X"}->Target]]').map(m => m.name)).toEqual(['goto']);
  });
});
