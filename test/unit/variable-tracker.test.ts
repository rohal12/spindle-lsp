import { describe, it, expect } from 'vitest';
import { VariableTracker, executableCode } from '../../src/core/workspace/variable-tracker.js';
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

  // Spindle 0.59 accepts a null default: `{ type: 'null' }`, "nothing yet", which
  // may later hold a value of any shape (parseDeclarations, validateRef).
  it('declares a null default in StoryVariables, a problem to nobody', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$name = "player"\n$bad = null\n$ok = 0\n$nested = { x: null }`, 5);
    expect(tracker.getNullDeclarations()).toEqual([]);
    expect(tracker.getInvalidDeclarations()).toEqual([]);
    expect(tracker.getDeclared().get('bad')).toMatchObject({
      name: 'bad',
      declarationRange: { start: { line: 6, character: 0 }, end: { line: 6, character: 4 } },
    });
    expect(tracker.getDeclared().get('bad')!.type).toBeUndefined();
    expect(tracker.getDeclared().get('nested')).toMatchObject({ type: 'object', fields: ['x'] });
  });

  it('declares a null default in StoryTransients, a problem to nobody', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryTransients(`%counter = 0\n%bad = null`, 10);
    expect(tracker.getNullTransientDeclarations()).toEqual([]);
    expect(tracker.getInvalidTransientDeclarations()).toEqual([]);
    expect(tracker.getDeclaredTransient().get('bad')?.declarationRange.start.line).toBe(11);
  });

  it('accepts any field of a null default, as Spindle does', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables('$held = null\n$o = { slot: null }');
    tracker.scanDocument('file:///story.tw', ':: Start\n{$held.name.first} {$o.slot.x.y}', []);
    expect(tracker.getPrimitiveFieldAccesses('file:///story.tw')).toEqual([]);
    expect(tracker.getUndeclared('file:///story.tw')).toEqual([]);
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

describe('declared types', () => {
  /** The type the tracker records for `$a = <expr>`: the static shape of the default. */
  function typeOf(expr: string): string | undefined {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables(`$a = ${expr}`);
    return tracker.getDeclared().get('a')?.type;
  }

  it.each([
    ['[]', 'array'],
    ['[1, [2, 3], { a: "]" }]', 'array'],
    ['{ a: [], b: "}" }', 'object'],
    ['"text"', 'string'],
    ["'it\\'s'", 'string'],
    ['`plain`', 'string'],
    ['42', 'number'],
    ['-1.5e3', 'number'],
    ['0x10', 'number'],
    ['true', 'boolean'],
  ])('types the literal %s as %s', (expr, type) => {
    expect(typeOf(expr)).toBe(type);
  });

  it.each([
    ['[1, 2].length'],
    ['["a"].join(",")'],
    ['{ a: 1 }.a'],
    ['`${x}`'],
    ['makeDefaults()'],
    ['null'],
  ])('does not guess the type of %s', (expr) => {
    expect(typeOf(expr)).toBeUndefined();
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

  // Matrix M8: a quoted key is a field like any other (parseDeclarations)
  it('lists the fields of an object default, quoted and numeric keys too', () => {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables('$o = { a: 1, "b c": { d: 1 }, \'e\': [], 2: 3, ...rest }\n$p = {}');
    expect(tracker.getDeclared().get('o')!.fields).toEqual(['a', 'b c', 'e', '2']);
    expect(tracker.getDeclared().get('p')!.fields).toBeUndefined();
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
    '{button "{$label}"}go{/button} {button "{%btnT}"}{/button}',
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
    expect(tracker.getUsages('label')[0].range.start).toEqual({ line: 5, character: 10 });
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
    // Spindle validates the references a passage executes; the text of a
    // string (`"plain $literal"`) is not one
    expect(tracker.getUndeclared('file:///story.tw').map(u => u.name)).toEqual([
      'init', 'box', 'check', 'tpl', 'label',
    ]);
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

  it('lets a quote in a macro head run past the end of its line, as the tokenizer does', () => {
    // The string runs to the closing quote: the macro is one token to the last brace
    const tracker = scan(':: Start\n{print "unclosed}\n{set $y = 1}"}');
    expect(tracker.getUsages('y')).toEqual([]);
    expect(undeclaredNames(tracker)).toEqual([]);
  });

  it('ignores literal text in strings inside code', () => {
    const tracker = scan([
      ':: Start',
      `{print "costs $a"} {print 'it\\'s $b'} {print "don't $c"}`,
      '{print $declared + \'x\'} {print $declared}',
    ].join('\n'));
    expect(tracker.getUsages('a')).toEqual([]);
    expect(tracker.getUsages('b')).toEqual([]);
    expect(tracker.getUsages('c')).toEqual([]);
    expect(tracker.getUsages('declared')).toHaveLength(2);
    // ...and Spindle's startup validation does not read them either
    expect(undeclaredNames(tracker)).toEqual([]);
  });

  it('reads code that is not JavaScript as the lexer does: a quote opens a string that runs on', () => {
    // `name's` opens a string, so what follows is text (a syntax error Spindle reports at startup)
    const tracker = scan(":: Start\n{print name's $declared}");
    expect(tracker.getUsages('declared')).toEqual([]);
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

  it('reports StoryInit, template, receiver and code references, not prose (issue example)', () => {
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
    ]);
  });

  it('reports {$…} blocks inside strings and quoted receivers of any input macro', () => {
    expect(undeclaredNames([
      ':: Start',
      '{link "{$label}"}go{/link}',
      '{checkbox \'$check\' "Label"} {numberbox "$num"}',
    ].join('\n'))).toEqual(['label', 'check', 'num']);
  });

  it('does not report plain text in macro string literals: it is JavaScript text', () => {
    const tracker = scan(':: Start\n{print "costs $price"} {foo \'$quoted\'} {set $x = `a $tpl b`}');
    expect(tracker.getUndeclared(uri)).toEqual([]);
    expect(tracker.getUsages('price')).toEqual([]);
  });

  it('does not report prose: HTML comments and inline script/style elements are text', () => {
    expect(undeclaredNames([
      ':: Start',
      '<!-- $inComment -->',
      '<script>let v = $inScript;</script>',
      '<style>/* $inStyle */</style>',
    ].join('\n'))).toEqual([]);
  });

  it('reports $ followed by digits where it is executed, not in prose', () => {
    expect(undeclaredNames(':: Start\nIt costs $5.50, or \\$cash. {$7} {$8.5}')).toEqual(['7', '8']);
  });

  it('validates dotted paths by their root, as Spindle does', () => {
    expect(undeclaredNames(
      ':: Start\n{$obj.a.deep} {$obj.unknown} {$list.length} {$nope.a.b}',
    )).toEqual(['nope']);
  });

  it('does not report the @locals a {for} binds; a $variable of the same name is another variable', () => {
    expect(undeclaredNames([
      ':: Loop',
      '{for @i, @item of $list}{@item}{@i.x}{/for}',
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

  // The members of the primitive's wrapper (`length`, `toFixed`) are fields of it
  it('reports a field of a string, number or boolean default that the wrapper does not have', () => {
    const tracker = scan(':: Start\n{print $name.length} {$hp.toFixed} {$on.x} {$name.nope}');
    expect(tracker.getPrimitiveFieldAccesses(uri)).toEqual([
      {
        path: '$on', field: 'x', type: 'boolean',
        range: { start: { line: 1, character: 40 }, end: { line: 1, character: 41 } },
      },
      {
        path: '$name', field: 'nope', type: 'string',
        range: { start: { line: 1, character: 50 }, end: { line: 1, character: 54 } },
      },
    ]);
  });

  it('walks nested object fields and reports the first field past a primitive', () => {
    expect(accesses(':: Start\n{$p.hp.max.y} {$p.s.label.nope} {$p.s.label.length} {$p.s} {$p.hp}')).toEqual([
      'Cannot access field "max" on $p.hp (type: number)',
      'Cannot access field "nope" on $p.s.label (type: string)',
    ]);
  });

  it('follows the type of a wrapper member: a number or string member is walked on', () => {
    expect(accesses(':: Start\n{$name.length.nope} {$name.toUpperCase.nope} {$hp.toFixed.nope}')).toEqual([
      'Cannot access field "nope" on $name.length (type: number)',
    ]);
  });

  it('allows unknown object fields and any field of an array, as Spindle does', () => {
    expect(accesses(':: Start\n{$p.missing.deep} {$p.inv.foo.bar} {$list.length} {$list.nope}')).toEqual([]);
  });

  it('does not guess the type of a default that is not a literal', () => {
    expect(accesses(':: Start\n{$calc.x} {$nil.x}')).toEqual([]);
  });

  it('reports every executed occurrence, not prose, strings or comments', () => {
    expect(accesses([
      ':: Start',
      'Hi $name.first! {print "$name.first"} <!-- $name.first -->',
      '{$name.first} {print $name.first}',
    ].join('\n'))).toHaveLength(2);
  });

  it('skips @locals, undeclared roots and passages Spindle does not validate', () => {
    expect(accesses([
      ':: Loop',
      '{for @name of $list}{@name.first} $name.first{/for}',
      ':: Other',
      '{$ghost.first}',
      ':: StoryTitle',
      '{$name.first}',
      ':: Code [script]',
      'window.$name.first = 1;',
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

describe('VariableTracker references the tooling API reads', () => {
  const uri = 'file:///story.tw';

  function scan(text: string): VariableTracker {
    const tracker = new VariableTracker();
    tracker.parseStoryVariables('$declared = 0');
    tracker.parseStoryTransients('%declaredT = 0');
    tracker.scanDocument(uri, text, []);
    return tracker;
  }

  /** The `$name`s Spindle's startup validation rejects, and the usages rename follows. */
  function names(text: string): { undeclared: string[]; usages: string[] } {
    const tracker = scan(text);
    const usages = ['a', 'b', 'c', 'd', 'e'].filter(name => tracker.getUsages(name).length > 0);
    return { undeclared: tracker.getUndeclared(uri).map(u => u.name), usages };
  }

  it('finds the variable a macro declares without validating it', () => {
    // `variable` parameters are not code: Spindle does not check them at startup
    expect(names(':: Start\n{unset $a}{computed $b = $c + 1}')).toEqual({ undeclared: ['c'], usages: ['a', 'b', 'c'] });
  });

  it('finds the variable of an unquoted input macro receiver and validates it', () => {
    expect(names(':: Start\n{textbox $a}{checkbox $b "Label with $c"}{cycle "$d"}')).toEqual({
      undeclared: ['a', 'b', 'd'], usages: ['a', 'b', 'd'],
    });
  });

  it('reads the labels of links and macros, which hold markup', () => {
    expect(names(':: Start\n[[Take {$a}->T]]{link "go {$b}" "T"}{button "{$c}"}x{/button}')).toEqual({
      undeclared: ['a', 'b', 'c'], usages: ['a', 'b', 'c'],
    });
  });

  it('reads attribute values, the code of onclick, and macros in them', () => {
    expect(names(':: Start\n<a title="{$a}" onclick="{$b = 1}" data-x="{if $c}1{/if}">x</a>')).toEqual({
      undeclared: ['a', 'b', 'c'], usages: ['a', 'b', 'c'],
    });
  });

  it('reads the selectors: validated on a macro, only found on a link, variable or expression', () => {
    expect(names(':: Start\n{.{$a} print 1}[[.{$b} Go->T]]{.{$c} $declared}{.{$d} $declared + 1}')).toEqual({
      undeclared: ['a'], usages: ['a', 'b', 'c', 'd'],
    });
  });

  it('reads a {do} body as statements and the arguments of a macro without parameters as code', () => {
    expect(names(':: Start\n{do}\n  $a = $b + 1; // $c\n  const s = "$d";\n{/do}\n{widgetCall $e, "$a"}')).toEqual({
      undeclared: ['a', 'b', 'e'], usages: ['a', 'b', 'e'],
    });
  });

  it('maps a reference in a string with escapes to its place in the source', () => {
    const text = ':: Start\n{button "say \\"hi\\" {$a} now"}x{/button}';
    const tracker = scan(text);
    expect(tracker.getUsages('a')).toEqual([
      { uri, range: { start: { line: 1, character: 21 }, end: { line: 1, character: 23 } } },
    ]);
    expect(text.split('\n')[1].slice(21, 23)).toBe('$a');
  });

  it('keeps positions in a CRLF document', () => {
    const tracker = scan(':: Start\r\nHello\r\n{$a} {set %b = 1}\r\n{if $c}\r\n[[Go {$d}->T]]{/if}');
    expect(tracker.getUsages('a')[0].range.start).toEqual({ line: 2, character: 1 });
    expect(tracker.getTransientUsages('b')[0].range.start).toEqual({ line: 2, character: 10 });
    expect(tracker.getUsages('c')[0].range.start).toEqual({ line: 3, character: 4 });
    expect(tracker.getUsages('d')[0].range).toEqual({
      start: { line: 4, character: 6 }, end: { line: 4, character: 8 },
    });
  });

  it('reads no reference in a passage the story does not render, nor in an unclosed or escaped block', () => {
    expect(names(':: Code [script]\nlet x = {$a};\n:: StoryVariables\n$b = 1\n:: Start\n\\{$c} {$d')).toEqual({
      undeclared: [], usages: [],
    });
  });

  it('keeps the StoryScript text out of the usages, but validates it like Spindle', () => {
    const tracker = scan(':: StoryScript\n{$a}\n:: Start\n{$b}');
    expect(tracker.getUsages('a')).toEqual([]);
    expect(tracker.getUndeclared(uri).map(u => u.name)).toEqual(['a', 'b']);
  });
});

describe('executableCode', () => {
  it('keeps only the variable references, in place', () => {
    const text = 'Hi $no {set _t to @l + %x} "$s" {$y.z}\r\n<!-- $c -->{for @i of $list}';
    const code = executableCode(text);
    expect(code.length).toBe(text.length);
    expect(code.replace(/\s+/g, ' ').trim()).toBe('_t @l %x $y.z @i $list');
  });
});
