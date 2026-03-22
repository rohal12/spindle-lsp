import { describe, it, expect } from 'vitest';
import { WidgetRegistry } from '../../src/core/workspace/widget-registry.js';
import type { Passage } from '../../src/core/types.js';

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
    expect(greeting!.params).toEqual(['name']);
    expect(greeting!.uri).toBe('file:///widgets.tw');

    const counter = registry.getWidget('counter');
    expect(counter).toBeDefined();
    expect(counter!.name).toBe('counter');
    expect(counter!.params).toEqual(['count', 'label']);
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
});
