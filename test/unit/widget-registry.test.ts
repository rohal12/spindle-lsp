import { describe, it, expect } from 'vitest';
import { builtinMacros, isBlockMacro } from '@rohal12/spindle/tooling';
import { WidgetRegistry } from '../../src/core/workspace/widget-registry.js';
import { PassageIndex } from '../../src/core/workspace/passage-index.js';
import { DocumentMarkup, type PassageMarkup } from '../../src/core/markup/passage-markup.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { findWidgetReferences } from '../../src/plugins/references.js';

const widgetDoc = `:: MyWidgets [widget]
{widget "greeting" @name}
Hello, {@name}!
{/widget}

{widget "counter" @count @label}
{@label}: {@count}
{/widget}
`;

const nonWidgetDoc = `:: NormalPassage
This is just a normal passage.
{if $x}hello{/if}
`;

/** The markup of the passages of some documents, read with the built-in macros. */
function markupOf(files: Record<string, string>): PassageMarkup[] {
  return Object.entries(files).flatMap(([uri, text]) => {
    const index = new PassageIndex();
    index.rebuild(uri, text);
    return new DocumentMarkup(uri, text, index.getPassagesInDocument(uri), { macros: builtinMacros, isBlock: isBlockMacro }).passages;
  });
}

function scanFiles(files: Record<string, string>): WidgetRegistry {
  const registry = new WidgetRegistry();
  registry.scan(markupOf(files), builtinMacros);
  return registry;
}

describe('WidgetRegistry', () => {
  it('scans widget passages and finds widget definitions', () => {
    expect(scanFiles({ 'file:///widgets.tw': widgetDoc }).getAllWidgets().length).toBe(2);
  });

  it('extracts widget name and parameters', () => {
    const registry = scanFiles({ 'file:///widgets.tw': widgetDoc });

    const greeting = registry.getWidget('greeting');
    expect(greeting).toBeDefined();
    expect(greeting!.name).toBe('greeting');
    expect(greeting!.params).toEqual(['@name']);
    expect(greeting!.uri).toBe('file:///widgets.tw');

    const counter = registry.getWidget('counter');
    expect(counter).toBeDefined();
    expect(counter!.name).toBe('counter');
    expect(counter!.params).toEqual(['@count', '@label']);
  });

  it('ignores passages without widget tag', () => {
    expect(scanFiles({ 'file:///normal.tw': nonWidgetDoc }).getAllWidgets().length).toBe(0);
    // A {widget} in a passage the runtime does not register widgets from
    expect(scanFiles({ 'file:///o.tw': ':: Other\n{widget "w"}x{/widget}\n' }).getAllWidgets()).toEqual([]);
  });

  it('registers the widgets of StoryInit, as the runtime does', () => {
    const registry = scanFiles({ 'file:///init.tw': ':: StoryInit\n{widget "fromInit" @a}x{/widget}\n' });
    expect(registry.getWidget('frominit')?.params).toEqual(['@a']);
  });

  it('returns undefined for unknown widget', () => {
    const registry = new WidgetRegistry();
    expect(registry.getWidget('nonexistent')).toBeUndefined();
  });

  it('handles an empty widget passage', () => {
    expect(scanFiles({ 'file:///empty.tw': ':: EmptyWidgets [widget]\n' }).getAllWidgets().length).toBe(0);
  });

  it('rescans and replaces previous results', () => {
    const registry = new WidgetRegistry();
    registry.scan(markupOf({ 'file:///widgets.tw': widgetDoc }), builtinMacros);
    expect(registry.getAllWidgets().length).toBe(2);

    registry.scan(markupOf({ 'file:///widgets.tw': ':: MyWidgets [widget]\n{widget "only-one" @x}\nhi\n{/widget}\n' }), builtinMacros);
    expect(registry.getAllWidgets().length).toBe(1);
    expect(registry.getWidget('only-one')).toBeDefined();
    expect(registry.getWidget('greeting')).toBeUndefined();
  });

  it('widget has correct range', () => {
    const greeting = scanFiles({ 'file:///widgets.tw': widgetDoc }).getWidget('greeting');
    expect(greeting).toBeDefined();
    // The widget definition is on line 1 (0-indexed) of the document
    expect(greeting!.range.start.line).toBe(1);
  });

  it('tracks widget invocations case-insensitively per document', () => {
    const registry = new WidgetRegistry();
    registry.recordInvocations('file:///a.tw', markupOf({ 'file:///a.tw': ':: A\n{Greeting "x"} {/Box}' }));
    registry.recordInvocations('file:///b.tw', markupOf({ 'file:///b.tw': ':: B\n{counter 1 "n"}' }));

    expect(registry.isInvoked('greeting')).toBe(true);
    expect(registry.isInvoked('COUNTER')).toBe(true);
    // A closing tag alone is not an invocation
    expect(registry.isInvoked('Box')).toBe(false);

    registry.recordInvocations('file:///a.tw', []);
    expect(registry.isInvoked('greeting')).toBe(false);
    expect(registry.isInvoked('counter')).toBe(true);

    registry.clearInvocations();
    expect(registry.isInvoked('counter')).toBe(false);
  });

  it('records the invocations in attribute values and labels, not those in comments', () => {
    const registry = new WidgetRegistry();
    registry.recordInvocations('file:///a.tw', markupOf({
      'file:///a.tw': ':: A\n<p title="{inAttr}">x</p> [[go {inLabel}->T]] {link "l {inLinkLabel}" "T"}x{/link}\n<!-- {inComment} -->\n',
    }));
    for (const name of ['inAttr', 'inLabel', 'inLinkLabel']) expect(registry.isInvoked(name), name).toBe(true);
    expect(registry.isInvoked('inComment')).toBe(false);
  });

  function scanWidgets(content: string): WidgetRegistry {
    return scanFiles({ 'file:///w.tw': content });
  }

  it('recognizes single-quoted and bare widget names', () => {
    const registry = scanWidgets(
      ":: W [widget]\n{widget 'hello' @name}Hello{/widget}\n{widget bye $who}Bye{/widget}\n",
    );
    expect(registry.getWidget('hello')?.params).toEqual(['@name']);
    expect(registry.getWidget('bye')?.params).toEqual([]);
  });

  it('reads the parameters as the runtime does (parseWidgetDef): the @ ones', () => {
    const registry = scanWidgets(
      ':: W [widget]\n{widget "mix" $a _b @c junk}{@c}{/widget}\n{widget "temp" _name}x{/widget}\n',
    );
    expect(registry.getWidget('mix')?.params).toEqual(['@c']);
    expect(registry.getWidget('temp')?.params).toEqual([]);
  });

  it('records the precise range of the widget name', () => {
    const registry = scanWidgets(
      ":: W [widget]\n  {widget 'hello' @x}a{/widget} {widget bare}b{/widget}\n",
    );
    expect(registry.getWidget('hello')!.nameRange).toEqual({
      start: { line: 1, character: 11 },
      end: { line: 1, character: 16 },
    });
    expect(registry.getWidget('bare')!.nameRange).toEqual({
      start: { line: 1, character: 40 },
      end: { line: 1, character: 44 },
    });
    expect(registry.getWidget('hello')!.range).toEqual({
      start: { line: 1, character: 2 },
      end: { line: 1, character: 21 },
    });
  });

  it('records the ranges in the document of a CRLF passage', () => {
    const registry = scanWidgets(':: W [widget]\r\nHello\r\n  {widget "w" @x}a{/widget}\r\n');
    expect(registry.getWidget('w')!.nameRange).toEqual({
      start: { line: 2, character: 11 },
      end: { line: 2, character: 12 },
    });
  });

  it('looks up widgets case-insensitively, keeping the original spelling', () => {
    const registry = scanWidgets(':: W [widget]\n{widget "Hello" @name}Hi{/widget}\n');
    for (const name of ['Hello', 'hello', 'HELLO']) {
      expect(registry.getWidget(name)?.name).toBe('Hello');
    }
    expect(registry.getAllWidgets().map(w => w.name)).toEqual(['Hello']);
  });

  it('marks widgets whose body renders {@children} as block widgets', () => {
    const registry = scanWidgets([
      ':: W [widget]',
      '{widget "wrap"}<div>{@children}</div>{/widget}',
      '{widget "panel" @title}',
      '<h2>{@title}</h2>',
      '{@children}',
      '{/widget}',
      '{widget "plain" @x}{@x}{/widget}',
      '{widget "commented"}<!-- {@children} -->{/widget}',
      '{widget "inlabel"}{button "{@children}"}x{/button}{/widget}',
    ].join('\n'));
    expect(registry.getWidget('wrap')!.block).toBe(true);
    expect(registry.getWidget('panel')!.block).toBe(true);
    expect(registry.getWidget('plain')!.block).toBe(false);
    // Decided on tokens: a comment does not render anything, a label does
    expect(registry.getWidget('commented')!.block).toBe(false);
    expect(registry.getWidget('inlabel')!.block).toBe(true);
  });

  it('ignores a definition in an HTML comment and keeps an unclosed one', () => {
    const registry = scanWidgets(':: W [widget]\n<!-- {widget "gone"}x{/widget} -->\n{widget "open"}never closed\n');
    expect(registry.getWidget('gone')).toBeUndefined();
    expect(registry.getWidget('open')).toBeDefined();
  });

  it('gives {@children} to the innermost of nested definitions', () => {
    const registry = scanWidgets(':: W [widget]\n{widget "outer"}{widget "inner"}{@children}{/widget}x{/widget}\n');
    expect(registry.getWidget('outer')!.block).toBe(false);
    expect(registry.getWidget('inner')!.block).toBe(true);
  });
});

describe('widgets in a workspace', () => {
  const files = new Map([
    ['file:///w.tw', ':: W [widget]\n{widget "wid"}x{/widget}\n{widget "box"}<b>{@children}</b>{/widget}\n'],
    ['file:///s.tw', [
      ':: Start',
      '{wid}',
      '<p title="{wid}">a</p>',
      '[[go {wid}->Start]]',
      '{link "l {wid}" "Start"}x{/link}',
      '<!-- {wid} -->',
      '{box}{/box} {/box}',
      '',
    ].join('\n')],
  ]);

  it('finds the calls in attribute values and labels, and none in comments or stray closers', () => {
    const model = new WorkspaceModel();
    model.initialize(files);
    const lines = (name: string) => findWidgetReferences(name, model, false).map(l => l.range.start.line);
    expect(lines('wid')).toEqual([1, 2, 3, 4]);
    // {/box} closes {box}; the second {/box} closes nothing
    expect(lines('box')).toEqual([6, 6]);
    expect(model.widgets.isInvoked('wid')).toBe(true);
    model.dispose();
  });

  it('pairs a block widget defined in a later document', () => {
    const model = new WorkspaceModel();
    model.initialize(new Map([
      ['file:///a.tw', ':: Start\n{box}x{/box}\n'],
      ['file:///b.tw', ':: W [widget]\n{widget "box"}{@children}{/widget}\n'],
    ]));
    expect(model.isContainer('box')).toBe(true);
    const pairing = model.markup.get('file:///a.tw')!.passages[0].pairing;
    expect(pairing.errors).toEqual([]);
    model.dispose();
  });
});
