import { describe, it, expect } from 'vitest';
import { VariableTracker, inferLiteralType } from '../../src/core/workspace/variable-tracker.js';
import type { MacroNode } from '../../src/core/types.js';

describe('VariableTracker', () => {
  it('parses StoryVariables declarations', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$name = "player"\n$health = 100\n$score = 0`);
    expect(tracker.hasStoryVariables()).toBe(true);
    const declared = tracker.getDeclared();
    expect(declared.size).toBe(3);
    expect(declared.has('name')).toBe(true);
    expect(declared.has('health')).toBe(true);
    expect(declared.has('score')).toBe(true);
  });

  it('parses object fields from StoryVariables', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$player = { name: "hero", hp: 100, inventory: [] }`);
    const declared = tracker.getDeclared();
    expect(declared.has('player')).toBe(true);
    const player = declared.get('player')!;
    expect(player.fields).toContain('name');
    expect(player.fields).toContain('hp');
    expect(player.fields).toContain('inventory');
  });

  it('skips comments and blank lines', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`// this is a comment\n\n$name = "test"\n<!-- html comment -->`);
    const declared = tracker.getDeclared();
    expect(declared.size).toBe(1);
    expect(declared.has('name')).toBe(true);
  });

  it('scans document for variable usages', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$name = "player"`);

    const macros: MacroNode[] = [];
    const text = `:: TestPassage\nHello {$name}, your score is {$score}.`;
    tracker.scanDocument('file:///story.tw', text, macros);

    const nameUsages = tracker.getUsages('name');
    expect(nameUsages.length).toBe(1);
    expect(nameUsages[0].uri).toBe('file:///story.tw');

    const scoreUsages = tracker.getUsages('score');
    expect(scoreUsages.length).toBe(1);
  });

  it('detects undeclared variables', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$name = "player"`);

    const text = `:: TestPassage\n{set $name to "bob"}\n{set $undeclared to 5}`;
    tracker.scanDocument('file:///story.tw', text, []);

    const undeclared = tracker.getUndeclared('file:///story.tw');
    expect(undeclared.length).toBeGreaterThan(0);
    const names = undeclared.map(u => u.name);
    expect(names).toContain('undeclared');
    expect(names).not.toContain('name');
  });

  it('tracks dot-notation field access', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$player = { hp: 100 }`);

    const text = `:: TestPassage\nHP: {$player.hp} / {$player.maxHp}`;
    tracker.scanDocument('file:///story.tw', text, []);

    const usages = tracker.getUsages('player');
    expect(usages.length).toBe(2);
  });

  it('hasStoryVariables returns false when none parsed', () => {
    const tracker = new VariableTracker();
    expect(tracker.hasStoryVariables()).toBe(false);
  });

  it('excludes special passages from scanning', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$name = "player"`);

    // StoryVariables, StoryInit content should not generate usages
    const text = `:: StoryVariables\n$name = "player"\n$count = 0`;
    tracker.scanDocument('file:///story.tw', text, []);

    // Usages within StoryVariables itself should be excluded
    const usages = tracker.getUsages('name');
    expect(usages.length).toBe(0);
  });

  it('skips passages tagged script or stylesheet', () => {
    const tracker = new VariableTracker();
    const text = [
      ':: Code [script]',
      'const $el = $("#x"); const m = a %mod;',
      ':: More [script extra]',
      'window.$helper = 1;',
      ':: Styles [stylesheet]',
      '.a::after { content: "$nope"; }',
      ':: Start',
      '{$real}',
    ].join('\n');
    tracker.scanDocument('file:///story.tw', text, []);
    expect(tracker.getUsages('el')).toEqual([]);
    expect(tracker.getUsages('helper')).toEqual([]);
    expect(tracker.getTransientUsages('mod')).toEqual([]);
    expect(tracker.getUndeclared('file:///story.tw').map(u => u.name)).toEqual(['real']);
  });

  it('detects null declarations in StoryVariables', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$name = "player"\n$bad = null\n$ok = 0`, 5);
    const nullDecls = tracker.getNullDeclarations();
    expect(nullDecls).toHaveLength(1);
    expect(nullDecls[0].name).toBe('bad');
    expect(nullDecls[0].sigil).toBe('$');
    expect(nullDecls[0].range.start.line).toBe(6); // line 5 + 1
    // Variable is still declared (to avoid double-flagging with SP200)
    expect(tracker.getDeclared().has('bad')).toBe(true);
  });

  it('detects null declarations in StoryTransients', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryTransients(`%counter = 0\n%bad = null`, 10);
    const nullDecls = tracker.getNullTransientDeclarations();
    expect(nullDecls).toHaveLength(1);
    expect(nullDecls[0].name).toBe('bad');
    expect(nullDecls[0].sigil).toBe('%');
    expect(nullDecls[0].range.start.line).toBe(11); // line 10 + 1
    expect(tracker.getDeclaredTransient().has('bad')).toBe(true);
  });

  it('does not flag non-null values as null declarations', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$a = 0\n$b = ""\n$c = false\n$d = []\n$e = { x: 1 }`);
    expect(tracker.getNullDeclarations()).toHaveLength(0);
  });

  it('replaces usages when re-scanning the same document', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$name = "player"`);

    tracker.scanDocument('file:///a.tw', ':: Test\n{$name}', []);
    expect(tracker.getUsages('name').length).toBe(1);

    tracker.scanDocument('file:///a.tw', ':: Test\n{$name} and {$name}', []);
    expect(tracker.getUsages('name').length).toBe(2);
  });
});

describe('inferLiteralType', () => {
  it('recognises single literals', () => {
    expect(inferLiteralType('[]')).toBe('array');
    expect(inferLiteralType('[1, [2, 3], { a: "]" }]')).toBe('array');
    expect(inferLiteralType('{ a: [], b: "}" }')).toBe('object');
    expect(inferLiteralType('"text"')).toBe('string');
    expect(inferLiteralType("'it\\'s'")).toBe('string');
    expect(inferLiteralType('`plain`')).toBe('string');
    expect(inferLiteralType('42')).toBe('number');
    expect(inferLiteralType('-1.5e3')).toBe('number');
    expect(inferLiteralType('true')).toBe('boolean');
  });

  it('returns undefined for anything that is not a single literal', () => {
    expect(inferLiteralType('[1, 2].length')).toBeUndefined();
    expect(inferLiteralType('["a"].join(",")')).toBeUndefined();
    expect(inferLiteralType('{ a: 1 }.a')).toBeUndefined();
    expect(inferLiteralType('`${x}`')).toBeUndefined();
    expect(inferLiteralType('makeDefaults()')).toBeUndefined();
    expect(inferLiteralType('[1, 2')).toBeUndefined();
    expect(inferLiteralType('null')).toBeUndefined();
    expect(inferLiteralType('')).toBeUndefined();
  });

  it('records the type on declarations', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$flags = []\n$pc = { name: "x" }\n$n = [1].length`);
    tracker.parseStoryTransients(`%queue = [1]`);
    expect(tracker.getDeclared().get('flags')!.type).toBe('array');
    expect(tracker.getDeclared().get('pc')!.type).toBe('object');
    expect(tracker.getDeclared().get('n')!.type).toBeUndefined();
    expect(tracker.getDeclaredTransient().get('queue')!.type).toBe('array');
  });
});

describe('VariableTracker.getArrayMemberAccesses', () => {
  it('returns non-array members accessed on array variables', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$flags = []\n$pc = { name: "x" }`);
    tracker.parseStoryTransients(`%queue = []`);
    tracker.scanDocument(
      'file:///a.tw',
      ':: Test\n{$flags.seen} {$flags.length} {$flags.includes("a")} {$pc.other} {%queue.head}',
      [],
    );
    const accesses = tracker.getArrayMemberAccesses('file:///a.tw');
    expect(accesses.map(a => `${a.sigil}${a.name}.${a.member}`)).toEqual(['$flags.seen', '%queue.head']);
    expect(accesses[0].range).toEqual({
      start: { line: 1, character: 1 },
      end: { line: 1, character: 12 },
    });
  });

  it('returns nothing for documents without usages', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$flags = []`);
    expect(tracker.getArrayMemberAccesses('file:///none.tw')).toEqual([]);
  });
});

describe('VariableTracker usage ranges after masked exclusions', () => {
  function usageAt(text: string, name: string) {
    const tracker = new VariableTracker();
    tracker.scanDocument('file:///story.tw', text, []);
    const usages = tracker.getUsages(name);
    expect(usages.length).toBe(1);
    return usages[0].range;
  }

  it('keeps line numbers after a multi-line HTML comment', () => {
    const text = ':: StoryVariables\n$x = 0\n:: Start\n<!-- comment\nmore -->\n{$missing}';
    expect(usageAt(text, 'missing')).toEqual({
      start: { line: 5, character: 1 },
      end: { line: 5, character: 9 },
    });
  });

  it('keeps line numbers after a multi-line script block', () => {
    const text = ':: Start\n<script>\nlet a = 1;\nlet b = 2;\n</script>\n{$x}';
    expect(usageAt(text, 'x').start).toEqual({ line: 5, character: 1 });
  });

  it('keeps line numbers after a multi-line style block', () => {
    const text = ':: Start\n<style>\n.a { color: red; }\n</style>\nText {$x}';
    expect(usageAt(text, 'x').start).toEqual({ line: 4, character: 6 });
  });

  it('keeps line numbers after a multi-line template literal', () => {
    const text = ':: Start\n{do `line one\nline two`}\n{$x}';
    expect(usageAt(text, 'x').start).toEqual({ line: 3, character: 1 });
  });

  it('keeps transient line numbers after a multi-line comment', () => {
    const tracker = new VariableTracker();
    tracker.scanDocument('file:///story.tw', ':: Start\n<!--\n\n-->\n{%t}', []);
    expect(tracker.getTransientUsages('t')[0].range.start).toEqual({ line: 4, character: 1 });
  });
});

describe('VariableTracker references in StoryInit and strings (#44, #62)', () => {
  const text = [
    ':: StoryInit',
    '{set $init = 1} {set %initT = 1}',
    ':: Start',
    '{textbox "$box"} {checkbox \'$check\' "Label"}',
    '{print `${$tpl}`} {print `${%tplT}`}',
    '{link "{$label}"}go{/link} {button "{%btnT}"}{/button}',
    '{print "plain $literal"} {foo "$notInput"}',
  ].join('\n');

  function scanned(): VariableTracker {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables('$declared = 0');
    tracker.parseStoryTransients('%declaredT = 0');
    tracker.scanDocument('file:///story.tw', text, []);
    return tracker;
  }

  it('records executable references for references and rename', () => {
    const tracker = scanned();
    expect(tracker.getUsages('init')[0].range.start).toEqual({ line: 1, character: 5 });
    expect(tracker.getUsages('box')[0].range).toEqual({
      start: { line: 3, character: 10 },
      end: { line: 3, character: 14 },
    });
    expect(tracker.getUsages('check')).toHaveLength(1);
    expect(tracker.getUsages('tpl')[0].range.start).toEqual({ line: 4, character: 10 });
    expect(tracker.getUsages('label')[0].range.start).toEqual({ line: 5, character: 8 });
    expect(tracker.getTransientUsages('initT')).toHaveLength(1);
    expect(tracker.getTransientUsages('tplT')).toHaveLength(1);
    expect(tracker.getTransientUsages('btnT')).toHaveLength(1);
  });

  it('still ignores literal string text', () => {
    const tracker = scanned();
    expect(tracker.getUsages('literal')).toEqual([]);
    expect(tracker.getUsages('notInput')).toEqual([]);
  });

  it('reports these references when undeclared, as Spindle does at startup (#62)', () => {
    const tracker = scanned();
    // Spindle validates every $name in a passage's raw text, string text included
    expect(tracker.getUndeclared('file:///story.tw').map(u => u.name)).toEqual([
      'init', 'box', 'check', 'tpl', 'label', 'literal', 'notInput',
    ]);
    // Transients are checked where they are evaluated, not in plain string text
    expect(tracker.getUndeclaredTransient('file:///story.tw').map(u => u.name)).toEqual([
      'initT', 'tplT', 'btnT',
    ]);
  });

  it('checks these references for array member access (#62)', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables('$list = []');
    tracker.scanDocument(
      'file:///story.tw',
      ':: StoryInit\n{set $list.bogus = 1}\n:: Start\n{print `${$list.nope}`}',
      [],
    );
    expect(tracker.getUsages('list')).toHaveLength(2);
    expect(tracker.getArrayMemberAccesses('file:///story.tw').map(a => a.member)).toEqual([
      'bogus', 'nope',
    ]);
  });
});

describe('VariableTracker string literals in prose and code', () => {
  function scan(text: string): VariableTracker {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables('$declared = 0');
    tracker.scanDocument('file:///story.tw', text, []);
    return tracker;
  }

  function undeclaredNames(tracker: VariableTracker): string[] {
    return tracker.getUndeclared('file:///story.tw').map(u => u.name);
  }

  it('does not treat apostrophes in prose as string delimiters', () => {
    const tracker = scan(":: Start\nDon't do it.\n{set $x = 2}\nIt's fine {$x}");
    expect(tracker.getUsages('x').map(u => u.range.start)).toEqual([
      { line: 2, character: 5 },
      { line: 3, character: 11 },
    ]);
    expect(undeclaredNames(tracker)).toEqual(['x']);
  });

  it('checks code inside quoted dialogue and HTML attributes', () => {
    // Quotes in markup are text: Spindle runs the macros between them.
    const tracker = scan([
      ':: Start',
      '"I {if $mood}hate{/if} you," she said.',
      '"Take {$gold}," he said.',
      '<div class="{$cls}">x</div>',
    ].join('\n'));
    expect(undeclaredNames(tracker)).toEqual(['mood', 'gold', 'cls']);
  });

  it('does not let a quote in code run past the end of its line', () => {
    const tracker = scan(':: Start\n{print "unclosed}\n{set $y = 1}"}');
    expect(tracker.getUsages('y').map(u => u.range.start)).toEqual([{ line: 2, character: 5 }]);
  });

  it('still ignores literal text in strings inside code', () => {
    const tracker = scan([
      ':: Start',
      `{print "costs $a"} {print 'it\\'s $b'} {print "don't $c"}`,
      "{print $declared + 'x'} {print name's $declared}",
    ].join('\n'));
    expect(tracker.getUsages('a')).toEqual([]);
    expect(tracker.getUsages('b')).toEqual([]);
    expect(tracker.getUsages('c')).toEqual([]);
    expect(tracker.getUsages('declared')).toHaveLength(2);
    // Spindle still validates them at startup (#62)
    expect(undeclaredNames(tracker)).toEqual(['a', 'b', 'c']);
  });
});

describe('VariableTracker undeclared references as Spindle validates them (#62)', () => {
  const uri = 'file:///story.tw';

  function scan(text: string): VariableTracker {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables('$x = 1\n$list = []\n$obj = { a: 1 }');
    tracker.parseStoryTransients('%t = 0');
    tracker.scanDocument(uri, text, []);
    return tracker;
  }

  function undeclaredNames(text: string): string[] {
    return scan(text).getUndeclared(uri).map(u => u.name);
  }

  it('reports StoryInit, template, receiver, code and prose references (issue example)', () => {
    const text = [
      ':: StoryVariables',
      '$x = 1',
      ':: StoryInit',
      '{set $missingInit = 2}',
      ':: Start',
      '{print `${$missingTemplate}`}',
      '{textbox "$missingReceiver"}',
      '{print $missingCode}',
      'It costs $missingProse today.',
    ].join('\n');
    const tracker = scan(text);
    expect(tracker.getUndeclared(uri)).toEqual([
      { name: 'missingInit', range: { start: { line: 3, character: 5 }, end: { line: 3, character: 17 } } },
      { name: 'missingTemplate', range: { start: { line: 5, character: 10 }, end: { line: 5, character: 26 } } },
      { name: 'missingReceiver', range: { start: { line: 6, character: 10 }, end: { line: 6, character: 26 } } },
      { name: 'missingCode', range: { start: { line: 7, character: 7 }, end: { line: 7, character: 19 } } },
      { name: 'missingProse', range: { start: { line: 8, character: 9 }, end: { line: 8, character: 22 } } },
    ]);
  });

  it('reports {$…} blocks inside strings and quoted receivers of any input macro', () => {
    expect(undeclaredNames([
      ':: Start',
      '{link "{$label}"}go{/link}',
      '{checkbox \'$check\' "Label"} {numberbox "$num"}',
    ].join('\n'))).toEqual(['label', 'check', 'num']);
  });

  it('reports plain text in macro string literals, which Spindle scans too', () => {
    const tracker = scan(':: Start\n{print "costs $price"} {foo \'$quoted\'} {set $x = `a $tpl b`}');
    expect(tracker.getUndeclared(uri).map(u => u.name)).toEqual(['price', 'quoted', 'tpl']);
    expect(tracker.getUndeclared(uri)[0].range).toEqual({
      start: { line: 1, character: 14 },
      end: { line: 1, character: 20 },
    });
    // String text is still not a reference for rename
    expect(tracker.getUsages('price')).toEqual([]);
  });

  it('reports references in HTML comments and inline script/style elements', () => {
    expect(undeclaredNames([
      ':: Start',
      '<!-- $inComment -->',
      '<script>let v = $inScript;</script>',
      '<style>/* $inStyle */</style>',
    ].join('\n'))).toEqual(['inComment', 'inScript', 'inStyle']);
  });

  it('reports $ followed by digits and escaped dollars, like Spindle\'s \\w+ match', () => {
    expect(undeclaredNames(':: Start\nIt costs $5.50, or \\$cash.')).toEqual(['5', 'cash']);
  });

  it('validates dotted paths by their root, as Spindle does', () => {
    expect(undeclaredNames(
      ':: Start\n{$obj.a.deep} {$obj.unknown} {$list.length} {$nope.a.b}',
    )).toEqual(['nope']);
  });

  it('does not report names a {for} in the same passage binds as locals', () => {
    expect(undeclaredNames([
      ':: Loop',
      '{for @i, @item of $list}{$item} $i{/for}',
      ':: Other',
      '{$item}',
    ].join('\n'))).toEqual(['item']);
  });

  it('does not report transients or jQuery-style $ calls', () => {
    expect(undeclaredNames(':: Start\n{set %t = 1} <script>$("#a"); $.noop();</script>')).toEqual([]);
  });

  it('checks every passage Spindle sees, including StoryInit and StoryInterface', () => {
    expect(undeclaredNames([
      ':: StoryVariables',
      '$x = 1',
      ':: StoryTransients',
      '%t = 0',
      ':: StoryData',
      '{"ifid": "$notAVar"}',
      ':: StoryTitle',
      'Costs $titleText',
      ':: Code [script]',
      'window.$helper = 1;',
      ':: Styles [stylesheet]',
      '.a::after { content: "$css"; }',
      ':: StoryInit',
      '{set $init = 1}',
      ':: StoryInterface',
      '<div>{$hud}</div>{passage}',
      ':: Widgets [widget]',
      '{widget "w"}{$inWidget}{/widget}',
    ].join('\n'))).toEqual(['init', 'hud', 'inWidget']);
  });

  it('does not report transients in plain string text', () => {
    const tracker = scan(':: Start\n{print "50 %off and %missing"}');
    expect(tracker.getUndeclaredTransient(uri)).toEqual([]);
  });
});

describe('VariableTracker CSS-prefixed variable displays (#58)', () => {
  function scan(text: string): VariableTracker {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables('$player = {}');
    tracker.scanDocument('file:///story.tw', text, []);
    return tracker;
  }

  it('records the variable of a prefixed display as a checked usage', () => {
    const tracker = scan(':: Start\n{.hero-name $player.name} {#id $ghost}');
    expect(tracker.getUsages('player').map(u => u.range)).toEqual([
      { start: { line: 1, character: 12 }, end: { line: 1, character: 24 } },
    ]);
    expect(tracker.getUndeclared('file:///story.tw').map(u => u.name)).toEqual(['ghost']);
  });

  it('binds the quoted receiver of a prefixed input macro', () => {
    const tracker = scan(':: Start\n{.cls#id textbox "$player"}');
    expect(tracker.getUsages('player')).toHaveLength(1);
  });

  it('does not bind a quoted receiver after selectors Spindle reads as text', () => {
    // No whitespace is allowed between selectors, so this is not a {textbox}
    const tracker = scan(':: Start\n{.red .bold textbox "$player"}');
    expect(tracker.getUsages('player')).toEqual([]);
  });
});

describe('VariableTracker field access on primitives (Spindle validateRef)', () => {
  const uri = 'file:///story.tw';
  const vars = [
    '$name = "Bob"',
    '$hp = 5',
    '$on = true',
    '$list = []',
    '$p = { hp: 1, s: { label: "x" }, inv: [] }',
    '$calc = 2 * 3',
    '$nil = null',
  ].join('\n');

  function scan(text: string): VariableTracker {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(vars);
    tracker.scanDocument(uri, text, []);
    return tracker;
  }

  function accesses(text: string): string[] {
    return scan(text).getPrimitiveFieldAccesses(uri)
      .map(a => `Cannot access field "${a.field}" on ${a.path} (type: ${a.type})`);
  }

  it('reports a field of a string, number or boolean default (issue example)', () => {
    const tracker = scan(':: Start\n{print $name.length} {$hp.toFixed} $on.x');
    expect(tracker.getPrimitiveFieldAccesses(uri)).toEqual([
      {
        path: '$name', field: 'length', type: 'string',
        range: { start: { line: 1, character: 13 }, end: { line: 1, character: 19 } },
      },
      {
        path: '$hp', field: 'toFixed', type: 'number',
        range: { start: { line: 1, character: 26 }, end: { line: 1, character: 33 } },
      },
      {
        path: '$on', field: 'x', type: 'boolean',
        range: { start: { line: 1, character: 39 }, end: { line: 1, character: 40 } },
      },
    ]);
  });

  it('walks nested object fields and reports the first field past a primitive', () => {
    expect(accesses(':: Start\n{$p.hp.max.y} {$p.s.label.length} {$p.s} {$p.hp}')).toEqual([
      'Cannot access field "max" on $p.hp (type: number)',
      'Cannot access field "length" on $p.s.label (type: string)',
    ]);
  });

  it('allows unknown object fields and any field of an array, as Spindle does', () => {
    expect(accesses(':: Start\n{$p.missing.deep} {$p.inv.foo.bar} {$list.length} {$list.nope}')).toEqual([]);
  });

  it('does not guess the type of a default that is not a literal', () => {
    expect(accesses(':: Start\n{$calc.x} {$nil.x}')).toEqual([]);
  });

  it('reports every occurrence, in prose, strings and comments too', () => {
    expect(accesses([
      ':: Start',
      'Hi $name.first! {print "$name.length"} <!-- $name.length -->',
      '{$name.length}',
    ].join('\n'))).toHaveLength(4);
  });

  it('skips {for} locals, undeclared roots and passages Spindle does not validate', () => {
    expect(accesses([
      ':: Loop',
      '{for @name of $list}{@name.length} $name.length{/for}',
      ':: Other',
      '$ghost.length',
      ':: StoryTitle',
      '$name.length',
      ':: Code [script]',
      'window.$name.length = 1;',
    ].join('\n'))).toEqual([]);
  });

  it('checks StoryInit and widget passages', () => {
    expect(accesses([
      ':: StoryInit',
      '{set $hp.max = 3}',
      ':: W [widget]',
      '{widget "w"}{$on.no}{/widget}',
    ].join('\n'))).toEqual([
      'Cannot access field "max" on $hp (type: number)',
      'Cannot access field "no" on $on (type: boolean)',
    ]);
  });
});
