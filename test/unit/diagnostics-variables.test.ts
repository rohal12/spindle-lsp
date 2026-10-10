/**
 * SP200 / SP201 / SP203 end to end: `computeDiagnostics` reports what
 * Spindle's startup validation (`validateVariableReferences`) rejects, with the
 * range of the reference. (The variable tracker used to mirror that validation;
 * its cases live here now. The differential against the runtime's own
 * validation is in executable-refs.test.ts and field-access-runtime.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'file:///story.tw';
const DECLARATIONS = ':: StoryVariables\n$declared = 0\n$x = 1\n$list = []\n$obj = { a: 1 }\n:: StoryTransients\n%t = 0\n';
/** The lines the declarations take before the passages of a test. */
const OFFSET = DECLARATIONS.split('\n').length - 1;

function diagnose(text: string, declarations = DECLARATIONS) {
  const model = new WorkspaceModel();
  model.initialize(new Map([[uri, declarations + text]]));
  return computeDiagnostics(uri, model);
}

/** The variables SP200 reports, as the diagnostics name them. */
function undeclared(text: string, declarations?: string): string[] {
  return diagnose(text, declarations).filter(d => d.code === 'SP200').map(d => d.message.replace('Undeclared variable: $', ''));
}

function undeclaredTransients(text: string): string[] {
  return diagnose(text).filter(d => d.code === 'SP203').map(d => d.message.replace('Undeclared transient: %', ''));
}

describe('SP200 for what a passage executes', () => {
  it('reports StoryInit, template, receiver and code references with their ranges, not prose (issue example)', () => {
    const found = diagnose([
      ':: StoryInit',
      '{set $missingInit = 2}',
      ':: Start',
      '{print `${$missingTemplate}`}',
      '{textbox "$missingReceiver"}',
      '{print $missingCode}',
      'It costs $missingProse today.',
    ].join('\n')).filter(d => d.code === 'SP200');
    const at = (line: number, start: number, end: number) => ({
      start: { line: OFFSET + line, character: start }, end: { line: OFFSET + line, character: end },
    });
    expect(found.map(d => [d.message, d.range])).toEqual([
      ['Undeclared variable: $missingInit', at(1, 5, 17)],
      ['Undeclared variable: $missingTemplate', at(3, 10, 26)],
      ['Undeclared variable: $missingReceiver', at(4, 10, 26)],
      ['Undeclared variable: $missingCode', at(5, 7, 19)],
    ]);
  });

  it('reports the references of every kind of input macro and of labels', () => {
    expect(undeclared(':: Start\n{link "{$label}"}go{/link}\n{checkbox \'$check\' "Label"} {numberbox "$num"}'))
      .toEqual(['label', 'check', 'num']);
    expect(undeclared(':: Start\n{textbox $a}{checkbox $b "Label with $c"}{cycle "$d"}')).toEqual(['a', 'b', 'd']);
    expect(undeclared(':: Start\n[[Take {$a}->T]]{link "go {$b}" "T"}{button "{$c}"}x{/button}')).toEqual(['a', 'b', 'c']);
  });

  it('reports a variable in code beside an apostrophe in prose, at each place', () => {
    expect(undeclared(":: Start\nDon't do it.\n{set $y = 2}\nIt's fine {$y}")).toEqual(['y', 'y']);
  });

  it('reports the code in quoted dialogue and in HTML attributes, which are text around macros', () => {
    expect(undeclared([
      ':: Start',
      '"I {if $mood}hate{/if} you," she said.',
      '"Take {$gold}," he said.',
      '<div class="{$cls}">x</div>',
    ].join('\n'))).toEqual(['mood', 'gold', 'cls']);
    expect(undeclared(':: Start\n<a title="{$a}" onclick="{$b = 1}" data-x="{if $c}1{/if}">x</a>')).toEqual(['a', 'b', 'c']);
  });

  it('does not report the text of a string, a template or a comment', () => {
    expect(undeclared(':: Start\n{print "costs $price"} {foo \'$quoted\'} {set $x = `a $tpl b`}')).toEqual([]);
    expect(undeclared(`:: Start\n{print "costs $a"} {print 'it\\'s $b'} {print "don't $c"}\n{print $declared + 'x'} {print $declared}`)).toEqual([]);
    expect(undeclared(':: Start\n<!-- $inComment -->\n<script>let v = $inScript;</script>\n<style>/* $inStyle */</style>')).toEqual([]);
  });

  it('lets a quote in a macro head run past the end of its line, as the tokenizer does', () => {
    expect(undeclared(':: Start\n{print "unclosed}\n{set $y = 1}"}')).toEqual([]);
  });

  it('reports $ followed by digits where it is executed, not in prose', () => {
    expect(undeclared(':: Start\nIt costs $5.50, or \\$cash. {$7} {$8.5}')).toEqual(['7', '8.5']);
  });

  it('validates a dotted path by its root', () => {
    expect(undeclared(':: Start\n{$obj.a.deep} {$obj.unknown} {$list.length} {$nope.a.b}')).toEqual(['nope.a.b']);
  });

  it('does not report the @locals a {for} binds; a $variable of the same name is another variable', () => {
    expect(undeclared([':: Loop', '{for @i, @item of $list}{@item}{@i.x}{/for}', ':: Other', '{$item}'].join('\n')))
      .toEqual(['item']);
  });

  it('does not report transients or jQuery-style $ calls as variables', () => {
    expect(undeclared(':: Start\n{set %t = 1} <script>$("#a"); $.noop();</script>')).toEqual([]);
  });

  it('reads the variable a macro declares and the arguments of a macro without parameters', () => {
    // `{unset $a}` and `{computed $b = ...}` name a variable: the story start does not check it
    expect(undeclared(':: Start\n{unset $a}{computed $b = $c + 1}')).toEqual(['c']);
    expect(undeclared(':: Start\n{do}\n  $a = $b + 1; // $c\n  const s = "$d";\n{/do}\n{widgetCall $e, "$a"}')).toEqual(['a', 'b', 'e']);
  });

  it('reads the selectors of a macro, not those of a link, a variable or an expression', () => {
    expect(undeclared(':: Start\n{.{$a} print 1}[[.{$b} Go->T]]{.{$c} $declared}{.{$d} $declared + 1}')).toEqual(['a']);
  });

  it('reads a CSS-prefixed display like a plain one', () => {
    expect(undeclared(':: Start\n{.hero-name $obj.a} {#id $ghost}')).toEqual(['ghost']);
    expect(undeclared(':: Start\n{.cls#id textbox "$obj"}')).toEqual([]);
  });

  it('reads no reference in a passage the story does not render, nor in an unclosed or escaped block', () => {
    expect(undeclared(':: Code [script]\nlet x = {$a};\n:: Start\n\\{$c} {$d')).toEqual([]);
  });

  it('checks every passage Spindle sees, including StoryInit, StoryInterface and widgets', () => {
    expect(undeclared([
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
    ].join('\n'), '')).toEqual(['init', 'hud', 'inWidget']);
  });

  it('places the range of a reference in a string with escapes and in a CRLF document', () => {
    const escaped = diagnose(':: Start\n{button "say \\"hi\\" {$a} now"}x{/button}').filter(d => d.code === 'SP200');
    expect(escaped.map(d => d.range)).toEqual([
      { start: { line: OFFSET + 1, character: 21 }, end: { line: OFFSET + 1, character: 23 } },
    ]);
    const crlf = diagnose(':: Start\r\nHello\r\n{$a} {set %b = 1}\r\n{if $c}\r\n[[Go {$d}->T]]{/if}');
    expect(crlf.filter(d => d.code === 'SP200').map(d => [d.message, d.range.start])).toEqual([
      ['Undeclared variable: $a', { line: OFFSET + 2, character: 1 }],
      ['Undeclared variable: $c', { line: OFFSET + 3, character: 4 }],
      ['Undeclared variable: $d', { line: OFFSET + 4, character: 6 }],
    ]);
  });

  it('accepts any field of a null default, as Spindle does', () => {
    const found = diagnose(':: Start\n{$held.name.first} {$o.slot.x.y}', ':: StoryVariables\n$held = null\n$o = { slot: null }\n');
    expect(found.filter(d => d.code === 'SP200' || d.code === 'SP201')).toEqual([]);
  });

  it('reports a variable of StoryScript like Spindle', () => {
    expect(undeclared(':: StoryScript\n{$a}\n:: Start\n{$b}')).toEqual(['a', 'b']);
  });
});

describe('SP203 for what a passage executes', () => {
  it('reports the transients of StoryInit, templates and labels, not those in the text of a string', () => {
    expect(undeclaredTransients([
      ':: StoryInit',
      '{set %initT = 1}',
      ':: Start',
      '{print `${%tplT}`} {button "{%btnT}"}{/button}',
      '{print "50 %off and %missing"}',
    ].join('\n'))).toEqual(['initT', 'tplT', 'btnT']);
  });
});

describe('SP201 field access on a primitive default', () => {
  const vars = ':: StoryVariables\n$name = "Bob"\n$hp = 5\n$on = true\n$list = []\n$p = { hp: 1, s: { label: "x" }, inv: [] }\n$calc = 2 * 3\n$nil = null\n';
  const fieldErrors = (text: string) => diagnose(text, vars).filter(d => d.code === 'SP201');
  const messages = (text: string) => fieldErrors(text).map(d => d.message);

  it('reports a field of a string, number or boolean that its wrapper does not have, with the range of the reference', () => {
    const line = vars.split('\n').length;
    expect(fieldErrors(':: Start\n{print $name.length} {$hp.toFixed} {$on.x} {$name.nope}').map(d => [d.message, d.range])).toEqual([
      ['Cannot access field "x" on $on (type: boolean)', { start: { line, character: 36 }, end: { line, character: 41 } }],
      ['Cannot access field "nope" on $name (type: string)', { start: { line, character: 44 }, end: { line, character: 54 } }],
    ]);
  });

  it('walks nested object fields and reports the first field past a primitive', () => {
    expect(messages(':: Start\n{$p.hp.max.y} {$p.s.label.nope} {$p.s.label.length} {$p.s} {$p.hp}')).toEqual([
      'Cannot access field "max" on $p.hp (type: number)',
      'Cannot access field "nope" on $p.s.label (type: string)',
    ]);
  });

  it('follows the type of a wrapper member: a number or string member is walked on', () => {
    expect(messages(':: Start\n{$name.length.nope} {$name.toUpperCase.nope} {$hp.toFixed.nope}')).toEqual([
      'Cannot access field "nope" on $name.length (type: number)',
    ]);
  });

  it('allows unknown object fields and any field of an array, and does not guess an untyped default', () => {
    expect(messages(':: Start\n{$p.missing.deep} {$p.inv.foo.bar} {$list.length} {$list.nope}')).toEqual([]);
    expect(messages(':: Start\n{$calc.x} {$nil.x}')).toEqual([]);
  });

  it('reports every executed occurrence, not prose, strings or comments', () => {
    expect(messages([
      ':: Start',
      'Hi $name.first! {print "$name.first"} <!-- $name.first -->',
      '{$name.first} {print $name.first}',
    ].join('\n'))).toHaveLength(2);
  });

  it('skips @locals, undeclared roots and passages Spindle does not validate', () => {
    expect(messages([
      ':: Loop',
      '{for @name of $list}{@name.first} $name.first{/for}',
      ':: Other',
      '{$ghost.first}',
      ':: Code [script]',
      'window.$name.first = 1;',
    ].join('\n'))).toEqual([]);
  });

  it('checks StoryInit and widget passages', () => {
    expect(messages([':: StoryInit', '{set $hp.max = 3}', ':: W [widget]', '{widget "w"}{$on.no}{/widget}'].join('\n'))).toEqual([
      'Cannot access field "max" on $hp (type: number)',
      'Cannot access field "no" on $on (type: boolean)',
    ]);
  });
});
