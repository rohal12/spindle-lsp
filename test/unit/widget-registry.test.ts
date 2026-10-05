import { describe, it, expect } from 'vitest';
import { WidgetRegistry } from '../../src/core/workspace/widget-registry.js';
import type { MacroNode, Passage } from '../../src/core/types.js';
import { parseMacros } from '../../src/core/parsing/macro-parser.js';

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

function makePassage(name: string, uri: string, tags?: string[], startLine = 0): Passage {
  return {
    name,
    uri,
    tags,
    range: {
      start: { line: startLine, character: 0 },
      end: { line: startLine + 10, character: 0 },
    },
    headerEnd: {
      start: { line: startLine, character: 0 },
      end: { line: startLine, character: name.length + 3 },
    },
  };
}

describe('WidgetRegistry', () => {
  it('scans widget passages and finds widget definitions', () => {
    const registry = new WidgetRegistry();
    const passages = [makePassage('MyWidgets', 'file:///widgets.tw', ['widget'])];
    const contents = new Map([['file:///widgets.tw', widgetDoc]]);
    registry.scan(passages, (uri) => contents.get(uri));

    expect(registry.getAllWidgets().length).toBe(2);
  });

  it('extracts widget name and parameters', () => {
    const registry = new WidgetRegistry();
    const passages = [makePassage('MyWidgets', 'file:///widgets.tw', ['widget'])];
    const contents = new Map([['file:///widgets.tw', widgetDoc]]);
    registry.scan(passages, (uri) => contents.get(uri));

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
    const registry = new WidgetRegistry();
    const passages = [makePassage('NormalPassage', 'file:///normal.tw')];
    const contents = new Map([['file:///normal.tw', nonWidgetDoc]]);
    registry.scan(passages, (uri) => contents.get(uri));

    expect(registry.getAllWidgets().length).toBe(0);
  });

  it('returns undefined for unknown widget', () => {
    const registry = new WidgetRegistry();
    expect(registry.getWidget('nonexistent')).toBeUndefined();
  });

  it('handles passage with no content', () => {
    const registry = new WidgetRegistry();
    const passages = [makePassage('EmptyWidgets', 'file:///empty.tw', ['widget'])];
    registry.scan(passages, () => undefined);
    expect(registry.getAllWidgets().length).toBe(0);
  });

  it('rescans and replaces previous results', () => {
    const registry = new WidgetRegistry();
    const passages = [makePassage('MyWidgets', 'file:///widgets.tw', ['widget'])];
    const contents1 = new Map([['file:///widgets.tw', widgetDoc]]);
    registry.scan(passages, (uri) => contents1.get(uri));
    expect(registry.getAllWidgets().length).toBe(2);

    // Rescan with different content
    const contents2 = new Map([[
      'file:///widgets.tw',
      `:: MyWidgets [widget]\n{widget "only-one" @x}\nhi\n{/widget}\n`,
    ]]);
    registry.scan(passages, (uri) => contents2.get(uri));
    expect(registry.getAllWidgets().length).toBe(1);
    expect(registry.getWidget('only-one')).toBeDefined();
    expect(registry.getWidget('greeting')).toBeUndefined();
  });

  it('widget has correct range', () => {
    const registry = new WidgetRegistry();
    const passages = [makePassage('MyWidgets', 'file:///widgets.tw', ['widget'])];
    const contents = new Map([['file:///widgets.tw', widgetDoc]]);
    registry.scan(passages, (uri) => contents.get(uri));

    const greeting = registry.getWidget('greeting');
    expect(greeting).toBeDefined();
    // The widget definition is on line 1 (0-indexed) of the document
    expect(greeting!.range.start.line).toBe(1);
  });

  it('tracks widget invocations case-insensitively per document', () => {
    const registry = new WidgetRegistry();
    registry.recordInvocations('file:///a.tw', parseMacros(':: A\n{Greeting "x"} {/Box}'));
    registry.recordInvocations('file:///b.tw', parseMacros(':: B\n{counter 1 "n"}'));

    expect(registry.isInvoked('greeting')).toBe(true);
    expect(registry.isInvoked('COUNTER')).toBe(true);
    // A closing tag alone is not an invocation
    expect(registry.isInvoked('Box')).toBe(false);

    registry.recordInvocations('file:///a.tw', [] as MacroNode[]);
    expect(registry.isInvoked('greeting')).toBe(false);
    expect(registry.isInvoked('counter')).toBe(true);

    registry.clearInvocations();
    expect(registry.isInvoked('counter')).toBe(false);
  });

  function scanWidgets(content: string): WidgetRegistry {
    const registry = new WidgetRegistry();
    const passages = [makePassage('W', 'file:///w.tw', ['widget'])];
    registry.scan(passages, () => content);
    return registry;
  }

  it('recognizes single-quoted and bare widget names', () => {
    const registry = scanWidgets(
      ":: W [widget]\n{widget 'hello' @name}Hello{/widget}\n{widget bye $who}Bye{/widget}\n",
    );
    expect(registry.getWidget('hello')?.params).toEqual(['@name']);
    expect(registry.getWidget('bye')?.params).toEqual(['$who']);
  });

  it('recognizes $, _ and @ parameters and ignores other tokens like the runtime', () => {
    const registry = scanWidgets(
      ':: W [widget]\n{widget "mix" $a _b @c junk @children}{@c}{/widget}\n{widget "temp" _name}x{/widget}\n',
    );
    expect(registry.getWidget('mix')?.params).toEqual(['$a', '_b', '@c']);
    expect(registry.getWidget('temp')?.params).toEqual(['_name']);
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

  it('looks up widgets case-insensitively, keeping the original spelling', () => {
    const registry = scanWidgets(':: W [widget]\n{widget "Hello" @name}Hi{/widget}\n');
    for (const name of ['Hello', 'hello', 'HELLO']) {
      expect(registry.getWidget(name)?.name).toBe('Hello');
    }
    expect(registry.getAllWidgets().map(w => w.name)).toEqual(['Hello']);
  });

});
