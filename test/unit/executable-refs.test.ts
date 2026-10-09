/**
 * Differential tests: the references the LSP validates (SP200/SP201) against
 * Spindle's own startup validation. From 0.50.1 the runtime scans only
 * executable references (tokenizer-based) and from 0.51.1 allows primitive
 * wrapper members; before, it scans the raw text.
 *
 *  - The first two describes use a vendored copy of the 0.51.3 runtime
 *    (test/fixtures/spindle-0.51.3), so they run whichever Spindle is installed.
 *  - The last describe follows the installed runtime: the LSP, given that
 *    version's capabilities, must agree with it. scripts/peer-matrix.sh runs
 *    it against each release.
 */
import { describe, it, expect } from 'vitest';
import {
  parseStoryVariables,
  validatePassages,
} from '../../node_modules/@rohal12/spindle/src/story-variables.js';
import {
  parseStoryVariables as vendoredParse,
  validatePassages as vendoredValidate,
} from '../fixtures/spindle-0.51.3/story-variables.js';
import { capabilitiesForVersion } from '../../src/core/workspace/spindle-version.js';
import { collectExecutableRefs } from '../../src/core/parsing/executable-refs.js';
import { VariableTracker } from '../../src/core/workspace/variable-tracker.js';
import { BUILTIN_STORE_VAR_MACROS } from '../../src/core/workspace/variable-tracker.js';
import { INSTALLED_CAPABILITIES } from '../helpers/spindle-version.js';

const uri = 'file:///story.tw';
const STORE_MACROS = new Set(BUILTIN_STORE_VAR_MACROS);

/** Every reference the 0.51.3 runtime validates, in order: all are undeclared in an empty schema. */
function runtimeRefs(content: string): string[] {
  const passages = new Map([['P', { name: 'P', tags: [], content } as never]]);
  return vendoredValidate(passages, new Map())
    .map(e => /Undeclared variable: \$(.*)$/.exec(e)![1]);
}

/** Names a `{for @a, @b of …}` in the passage binds: the runtime does not validate them. */
function forLocals(content: string): Set<string> {
  const names = new Set<string>();
  for (const m of content.matchAll(/\{for\s+@(\w+)(?:\s*,\s*@(\w+))?\s+of\b/g)) {
    names.add(m[1]);
    if (m[2]) names.add(m[2]);
  }
  return names;
}

const FRAGMENTS = [
  'Hello $name.first, ', '{$a}', '{$a.b.c}', '{$a + $b}', '{$a ? "$s" : \'$t\'}', '{set $x = $y + 1}',
  '{if $a > 0}', '{elseif $b.c}', '{else}', '{/if}', '{print `x ${$v.w} y $z`}', '{print "{$q.r} $nope"}',
  "{print 'it\\'s $esc'}", '<!-- $c.d -->', '// $line.c\n', '/* $blk */', '{do}\n$d.e = 1; // $f\n{/do}',
  '{do} $g {/do}', '{DO}$h{/DO}', '{do}$unclosed', '[[Go $x|Target $y]]', '[[$link->T]]', '\\{$esc} ', '\\$x ',
  '<a href="{$u.v}" class=\'k {$w}\' data-x="{$a ? "}" : "z"}">', '<img src="$bare {$img}">', '<br>', '</div>',
  '<span title={$un}>', '<input value="{$in.v}">', '</input>', '<p data-a="1" data-a="{$dup}">',
  '{textbox "$tb.x"}', '{textbox $tb2}', '{numberbox "$nb" 0}', "{cycle '$cy'}", '{checkbox "$cb.f" "l"}',
  '{.cls#id $sel.a}', '{#i.c print $pre}', '{.c _t}', '{.c @loc}', '{.c %tr}', '{_t.u + $m}', '{@l.m}', '{%tr.x}',
  '{{$brace}}', '{ $space }', '{$unbalanced', '{$a + "}"}', '{macro "}" $afterq}', "{x 'don't $apos}",
  'plain $prose.text and $5.50 ', '$', '$.x', '{', '}', '[[', ']]', '<', '< $lt', '\n', '\r\n', ' ',
  '{for @i of $list}{@i.x}$list.y{/for}', '{for @k, @v of $obj}$obj.k{/for}', '{link "go $l" "T"}{/link}',
  '[[Take {$lbl}->T{$tg}]]', '[[.c{$sel}#i{$sid} go->T]]', '{button "{$bt}"}x{/button}', '{dialog "Open {$dg}"}P{/dialog}',
  '{include "P"}', '{goto "$gt"}', '{widget "w"}{$wd}{/widget}', '{set $o = {a: $in1, b: "$in2"}}',
  '`tpl ${$tp}`', "{print '{$nested}'}", '{print "a\\"$b"}', 'é {$u8}', '😀 $emoji.x {$e2}',
];

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('executable references match the 0.51.3 runtime', () => {
  it('agrees with validatePassages on every fragment and on random passages', () => {
    const cases = FRAGMENTS.map(f => f);
    const random = rng(42);
    for (let n = 0; n < 4000; n++) {
      const count = 1 + Math.floor(random() * 6);
      let text = '';
      for (let k = 0; k < count; k++) text += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
      cases.push(text);
    }
    for (const content of cases) {
      const locals = forLocals(content);
      const lsp = collectExecutableRefs(content, STORE_MACROS).map(r => r.ref).filter(r => !locals.has(r.split('.')[0]));
      expect({ content, refs: lsp }).toEqual({ content, refs: runtimeRefs(content) });
    }
  });

  it('reports the offset of each reference `$`', () => {
    const random = rng(7);
    for (let n = 0; n < 1500; n++) {
      let content = '';
      for (let k = 0; k < 5; k++) content += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
      for (const { ref, offset } of collectExecutableRefs(content, STORE_MACROS)) {
        expect({ content, at: content.slice(offset, offset + 1 + ref.length) }).toEqual({ content, at: `$${ref}` });
      }
    }
  });
});

const V0513 = capabilitiesForVersion('0.51.3');

describe('SP201 under 0.51.3 capabilities matches the 0.51.3 runtime', () => {
  const DEFAULTS = ['5', '-1.5', '"s"', 'true', '[]', '{}', '{a: 1}', '{a: "x", b: {c: 1, d: "y"}}', '{s: "x", n: 2, arr: [1]}'];
  const PATHS = [
    'a', 'x', 'length', 'toFixed', 'toString', 'constructor', '__proto__', 'valueOf', 'a.b', 'a.length', 'a.toFixed',
    'length.x', 'length.toFixed', 'toFixed.x', 'b.c.length', 'b.d.length.x', 'b.d.toUpperCase.x', 'b.c.x',
    's.length', 's.length.y', 'n.toFixed', 'n.toFixed.z', 'arr.length', 'arr.length.q', 'at', 'charAt', 'big', '0',
    'toUpperCase', 'toUpperCase.x', 'length.length', 'length.length.length',
  ];

  it('reports the same field errors as validatePassages, across defaults and paths', () => {
    let compared = 0;
    for (const def of DEFAULTS) {
      for (const path of PATHS) {
        const vars = `$v = ${def}`;
        const content = `{print $v.${path}}`;
        const runtime = vendoredValidate(
          new Map([['Start', { name: 'Start', tags: [], content } as never]]),
          vendoredParse(vars),
        ).map(e => e.replace(/^Passage "[^"]*": /, ''));
        const text = `:: StoryVariables\n${vars}\n\n:: Start\n${content}\n`;
        const tracker = new VariableTracker();
        tracker.setCapabilities(V0513);
        tracker.parseStoryVariables(vars, 1, uri);
        tracker.scanDocument(uri, text, []);
        const lsp = tracker.getPrimitiveFieldAccesses(uri)
          .map(a => `Cannot access field "${a.field}" on ${a.path} (type: ${a.type})`);
        // The LSP never reports what the runtime accepts; it may miss only
        // what it cannot type without evaluating code (none of these defaults)
        expect({ def, path, lsp }).toEqual({ def, path, lsp: runtime });
        compared++;
      }
    }
    expect(compared).toBe(DEFAULTS.length * PATHS.length);
  });
});

/** The names the LSP reports undeclared in a document, against the runtime's. */
function lspUndeclared(passages: Array<[string, string]>): string[] {
  const text = [':: StoryVariables', '$decl = 1', '', ...passages.flatMap(([n, c]) => [`:: ${n}`, c, ''])].join('\n');
  const tracker = new VariableTracker();
  tracker.setCapabilities(INSTALLED_CAPABILITIES);
  tracker.parseStoryVariables('$decl = 1', 1, uri);
  tracker.scanDocument(uri, text, []);
  return tracker.getUndeclared(uri).map(u => u.name).sort();
}

function runtimeUndeclared(passages: Array<[string, string]>): string[] {
  const schema = parseStoryVariables('$decl = 1');
  const map = new Map(passages.map(([name, content]) => [name, { name, tags: [], content } as never]));
  const names = new Set(
    validatePassages(map, schema).map(e => /Undeclared variable: \$(\w+)/.exec(e)![1]),
  );
  return [...names].sort();
}

describe('SP200 follows the installed Spindle', () => {
  it('agrees with validatePassages, including {for} locals, across versions', () => {
    const random = rng(99);
    for (let n = 0; n < 1500; n++) {
      let content = '';
      const count = 1 + Math.floor(random() * 6);
      for (let k = 0; k < count; k++) content += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
      // A line break keeps a document's text from running into the next header
      const passages: Array<[string, string]> = [['Start', content.replace(/\r/g, '')], ['Other', '{$decl}']];
      expect({ content, names: lspUndeclared(passages) }).toEqual({ content, names: runtimeUndeclared(passages) });
    }
  });

  it('flags prose references only before 0.50.1', () => {
    const names = lspUndeclared([['Start', 'Hello $nobody and "$nothing" <!-- $none -->']]);
    expect(names).toEqual(INSTALLED_CAPABILITIES.executableRefsOnly ? [] : ['nobody', 'none', 'nothing']);
  });
});
