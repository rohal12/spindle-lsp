import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';

const storyFile = `:: Start
Hello, {$name}!
Go to [[Kitchen]].

:: Kitchen [nobr]
You see a table.

:: StoryVariables
$name = "player"
$health = 100

:: StoryInit
{set $ready to true}

:: MyWidgets [widget]
{widget "greeting" @name}
Hello, {@name}!
{/widget}
`;

const secondFile = `:: Ending
The end.
`;

describe('WorkspaceModel', () => {
  let model: WorkspaceModel;

  beforeEach(() => {
    model = new WorkspaceModel();
  });

  it('constructs without errors', () => {
    expect(model).toBeDefined();
    expect(model.documents).toBeDefined();
    expect(model.passages).toBeDefined();
    expect(model.macros).toBeDefined();
    expect(model.variables).toBeDefined();
    expect(model.widgets).toBeDefined();
  });

  it('initializes with file contents', async () => {
    const files = new Map<string, string>([
      ['file:///story.tw', storyFile],
      ['file:///ending.tw', secondFile],
    ]);

    model.initialize(files);

    // Documents should be loaded
    expect(model.documents.has('file:///story.tw')).toBe(true);
    expect(model.documents.has('file:///ending.tw')).toBe(true);

    // Passages should be indexed
    const allPassages = model.passages.getAllPassages();
    expect(allPassages.length).toBe(6); // Start, Kitchen, StoryVariables, StoryInit, MyWidgets, Ending

    // Special passages tracked
    expect(model.passages.getStoryVariables()).toBeDefined();
    expect(model.passages.getStoryInit()).toBeDefined();
  });

  it('populates macros from builtins', () => {
    model.initialize(new Map());
    // Should have built-in macros loaded
    expect(model.macros.getMacro('if')).toBeDefined();
    expect(model.macros.getMacro('set')).toBeDefined();
  });

  it('populates variables from StoryVariables passage', () => {
    const files = new Map([['file:///story.tw', storyFile]]);
    model.initialize(files);

    expect(model.variables.hasStoryVariables()).toBe(true);
    const declared = model.variables.getDeclared();
    expect(declared.has('name')).toBe(true);
    expect(declared.has('health')).toBe(true);
  });

  it('populates widgets from widget passages', () => {
    const files = new Map([['file:///story.tw', storyFile]]);
    model.initialize(files);

    const greeting = model.widgets.getWidget('greeting');
    expect(greeting).toBeDefined();
    expect(greeting!.params).toEqual(['name']);
  });

  it('emits modelReady after initialize', async () => {
    const handler = vi.fn();
    model.on('modelReady', handler);

    const files = new Map([['file:///story.tw', storyFile]]);
    model.initialize(files);

    // modelReady is debounced — wait for it
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(handler).toHaveBeenCalled();
  });

  it('rebuilds on document change', async () => {
    const files = new Map([['file:///story.tw', storyFile]]);
    model.initialize(files);

    const readyHandler = vi.fn();
    model.on('modelReady', readyHandler);

    // Simulate a document update
    model.documents.update('file:///story.tw', storyFile + '\n:: NewPassage\nContent here.');

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(readyHandler).toHaveBeenCalled();

    // The new passage should be indexed
    expect(model.passages.getPassage('NewPassage')).toBeDefined();
  });

  it('handles document close', () => {
    const files = new Map([
      ['file:///a.tw', ':: Alpha\nHello'],
      ['file:///b.tw', ':: Beta\nWorld'],
    ]);
    model.initialize(files);
    expect(model.passages.getAllPassages().length).toBe(2);

    model.documents.close('file:///a.tw');
    // After close, passages from that document should be removed
    expect(model.passages.getPassage('Alpha')).toBeUndefined();
    expect(model.passages.getPassage('Beta')).toBeDefined();
  });

  it('dispose removes all listeners', () => {
    model.initialize(new Map());
    model.dispose();
    // After dispose, updating a document should not cause errors
    // (listeners are removed, no cascade happens)
    expect(() => model.documents.update('file:///test.tw', 'content')).not.toThrow();
  });
});
