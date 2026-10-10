/**
 * Differential tests: the references the LSP validates (SP200/SP201) against
 * Spindle's own startup validation (`validateVariableReferences`, through
 * test/helpers/story-variables-oracle.ts): executable references only;
 * members of a primitive's wrapper allowed.
 */
import { describe, it, expect } from 'vitest';
import { parseStoryVariables, validatePassages } from '../helpers/story-variables-oracle.js';
import { collectVariableReferences } from '../../src/core/parsing/executable-refs.js';
import { VariableTracker } from '../../src/core/workspace/variable-tracker.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';

const uri = 'file:///story.tw';

/** The compiler's line breaks: Spindle reads passages with LF. */
function compiled(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

/** Every reference the runtime validates: all are undeclared in an empty schema. */
function runtimeRefs(content: string): string[] {
  const passages = new Map([['P', { name: 'P', tags: [], content: compiled(content) } as never]]);
  return validatePassages(passages, new Map())
    .map(e => /Undeclared variable: \$(.*)$/.exec(e)![1]);
}

/** The `$` references the LSP validates in the body of a passage, with their offsets in its (LF) content. */
function lspRefs(content: string): { content: string; refs: Array<{ path: string; start: number; end: number }> } {
  const model = new WorkspaceModel();
  model.initialize(new Map([[uri, `:: P\n${content}`]]));
  const passage = model.markup.get(uri)!.passages[0];
  const refs = collectVariableReferences(passage)
    .filter(r => r.sigil === '$' && r.validated);
  return { content: passage.content, refs };
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
  '[[Take {$lbl}->T{$tg}]]', '[[.c{$sel} #i{$sid} go->T]]', '{button "{$bt}"}x{/button}', '{dialog "Open {$dg}"}P{/dialog}',
  '{include "P"}', '{goto "$gt"}', '{widget "w"}{$wd}{/widget}', '{set $o = {a: $in1, b: "$in2"}}',
  '`tpl ${$tp}`', "{print '{$nested}'}", '{print "a\\"$b"}', 'é {$u8}', '😀 $emoji.x {$e2}',
  '{unset $un1}', '{computed $cp = $z2 + 1}', '{myw $arg1, "$arg2"}', '{watch "$cond > 1" goto "T"}', '{meter $cur $max "L {$ml}"}',
  '{radiobutton "$rb" "v" "L {$rl}"}', '{listbox "$lb"}{/listbox}', '{type 50ms}{$ty}{/type}', '{case $cs}', '{switch $sw}{case 1}{/switch}',
  '<button onclick="{$ck = 1}">x</button>', '<a onclick="{$oc} {$oc2}">y</a>',
  '{.{$cls} button "x {$bl}"}go{/button}', '{#{$idd} print $pp}', '{link "x{$y1}" "{$z1}"}go{/link}', '{link $lk1 $lk2}',
  '{goto $gt1}', '{goto "T{$gt2}"}', '{include $inc1}', '{include inline $inc2}', '{cycle $cyc "a" "b"}',
  '{textbox "$tbq" "ph {$ph}"}', '{checkbox $cbu "label {$cbl}"}', '{radiobutton $rbu "v"}',
  '{timed 1s}{$tm}{/timed}', '{set $a to 1}', '{set $a = $b, _c = $d}', '{print $a?.b}', '{for _i of $arr}{_i}{/for}',
  '{widget "w2" @p1 @p2}{@p1} {$wp}{/widget}', '{w2 $wa1, $wa2}', '{w2 "$ws"}', '{unknownmacro $um1 "$um2"}',
  '<div class="a {$dc}" id=\'{$di}\' data-v={$dv}>', '<p title="{if $pt}x{/if}">', '<div {$bad}>', '<div title="{$unterminated>',
  '{print /re$/ + $ff}', '{do}\n/* $hh */ let x = `${$ii}`; $jj++;\n{/do}', '{do}a{/do}{$after1}', '{do}{$inside}{/do}',
];

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomPassages(seed: number, count: number, size: number): string[] {
  const random = rng(seed);
  const cases = [...FRAGMENTS];
  for (let n = 0; n < count; n++) {
    let text = '';
    const parts = 1 + Math.floor(random() * size);
    for (let k = 0; k < parts; k++) text += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
    cases.push(text);
  }
  return cases;
}

describe('executable references match the runtime', () => {
  it('agrees with validatePassages on every fragment and on random passages', () => {
    for (const content of randomPassages(42, 4000, 6)) {
      // The same references; the LSP lists them in source order, and the runtime scans the selectors of a macro after its arguments
      const lsp = lspRefs(content).refs.map(r => r.path).sort();
      expect({ content, refs: lsp }).toEqual({ content, refs: runtimeRefs(content).sort() });
    }
  });

  it('reports the offset of each reference `$`', () => {
    for (const content of randomPassages(7, 1500, 5)) {
      const { content: lf, refs } = lspRefs(content);
      for (const { path, start, end } of refs) {
        expect({ content, at: lf.slice(start, end) }).toEqual({ content, at: `$${path}` });
      }
    }
  });
});

describe('SP201 matches the runtime', () => {
  const DEFAULTS = ['5', '-1.5', '"s"', 'true', '[]', '{}', '{a: 1}', '{a: "x", b: {c: 1, d: "y"}}', '{s: "x", n: 2, arr: [1]}', 'null', '{a: null}'];
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
        const runtime = validatePassages(
          new Map([['Start', { name: 'Start', tags: [], content } as never]]),
          parseStoryVariables(vars),
        ).map(e => e.replace(/^Passage "[^"]*": /, ''));
        const text = `:: StoryVariables\n${vars}\n\n:: Start\n${content}\n`;
        const tracker = new VariableTracker();
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
  it('agrees with validatePassages on random passages', () => {
    for (const content of randomPassages(99, 1500, 6)) {
      // A line break keeps a document's text from running into the next header
      const passages: Array<[string, string]> = [['Start', content.replace(/\r/g, '')], ['Other', '{$decl}']];
      expect({ content, names: lspUndeclared(passages) }).toEqual({ content, names: runtimeUndeclared(passages) });
    }
  });

  it('flags no prose reference: only what a passage executes', () => {
    expect(lspUndeclared([['Start', 'Hello $nobody and "$nothing" <!-- $none -->']])).toEqual([]);
  });
});
