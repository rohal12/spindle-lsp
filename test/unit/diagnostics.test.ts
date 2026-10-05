import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics, resolveIncludeTarget } from '../../src/plugins/diagnostics.js';
import { parseMacros } from '../../src/core/parsing/macro-parser.js';
import { MacroRegistry } from '../../src/core/workspace/macro-registry.js';

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8');
}

function createWorkspaceFrom(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const model = new WorkspaceModel();
  const fileContents = new Map<string, string>();
  for (const f of files) {
    fileContents.set(`file:///${f.name}`, f.content);
  }
  model.initialize(fileContents);
  return model;
}

function createWorkspaceFromFixture(fixtureName: string): WorkspaceModel {
  const content = readFixture(fixtureName);
  return createWorkspaceFrom({ name: fixtureName, content });
}

describe('computeDiagnostics', () => {
  it('produces no error diagnostics for valid story', () => {
    const workspace = createWorkspaceFromFixture('valid-story.tw');
    const diags = computeDiagnostics('file:///valid-story.tw', workspace);
    const errors = diags.filter(d => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('produces SP100 for undefined macro', () => {
    const workspace = createWorkspaceFromFixture('errors.tw');
    const diags = computeDiagnostics('file:///errors.tw', workspace);
    const sp100 = diags.filter(d => d.code === 'SP100');
    expect(sp100.length).toBeGreaterThan(0);
    expect(sp100[0].message).toContain('unknownMacro');
  });

  it('produces SP101 for unmatched container', () => {
    const workspace = createWorkspaceFromFixture('errors.tw');
    const diags = computeDiagnostics('file:///errors.tw', workspace);
    const sp101 = diags.filter(d => d.code === 'SP101');
    expect(sp101.length).toBeGreaterThan(0);
  });

  it('produces SP104 for illegal closing tag', () => {
    const text = `:: TestPassage\n{/set}`;
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
    const diags = computeDiagnostics('file:///test.tw', workspace);
    const sp104 = diags.filter(d => d.code === 'SP104');
    expect(sp104.length).toBeGreaterThan(0);
    expect(sp104[0].message).toContain('set');
  });

  it('produces SP107 for invalid parent constraint', () => {
    const workspace = createWorkspaceFromFixture('errors.tw');
    const diags = computeDiagnostics('file:///errors.tw', workspace);
    const sp107 = diags.filter(d => d.code === 'SP107');
    expect(sp107.length).toBeGreaterThan(0);
    expect(sp107[0].message).toContain('option');
  });

  it('produces SP200 for undeclared variable with error severity', () => {
    const workspace = createWorkspaceFromFixture('variables.tw');
    const diags = computeDiagnostics('file:///variables.tw', workspace);
    const sp200 = diags.filter(d => d.code === 'SP200');
    expect(sp200.length).toBeGreaterThan(0);
    expect(sp200.some(d => d.message.includes('$unknown'))).toBe(true);
    expect(sp200[0].severity).toBe('error');
  });

  it('does not flag declared variables as SP200', () => {
    const workspace = createWorkspaceFromFixture('variables.tw');
    const diags = computeDiagnostics('file:///variables.tw', workspace);
    const sp200 = diags.filter(d => d.code === 'SP200');
    // $health is declared, should not appear
    expect(sp200.some(d => d.message.includes('$health'))).toBe(false);
  });

  it('produces SP202 when no StoryVariables passage exists', () => {
    const text = `:: Start\n{set $x = 1}`;
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
    const diags = computeDiagnostics('file:///test.tw', workspace);
    const sp202 = diags.filter(d => d.code === 'SP202');
    expect(sp202.length).toBeGreaterThan(0);
    expect(sp202[0].severity).toBe('info');
  });

  it('produces SP300 for broken passage link', () => {
    const workspace = createWorkspaceFromFixture('errors.tw');
    const diags = computeDiagnostics('file:///errors.tw', workspace);
    const sp300 = diags.filter(d => d.code === 'SP300');
    expect(sp300.length).toBeGreaterThan(0);
    expect(sp300[0].message).toContain('NonExistent');
  });

  it('does not produce SP300 for valid passage links', () => {
    const workspace = createWorkspaceFromFixture('valid-story.tw');
    const diags = computeDiagnostics('file:///valid-story.tw', workspace);
    const sp300 = diags.filter(d => d.code === 'SP300');
    expect(sp300).toHaveLength(0);
  });

  it('produces SP301 for widget argument count mismatch', () => {
    const widgetFile = `:: Widgets [widget]\n{widget "greet" @name}\nHello {@name}\n{/widget}`;
    const storyFile = `:: Start\n{greet}`;
    const workspace = createWorkspaceFrom(
      { name: 'widgets.tw', content: widgetFile },
      { name: 'story.tw', content: storyFile },
    );
    const diags = computeDiagnostics('file:///story.tw', workspace);
    const sp301 = diags.filter(d => d.code === 'SP301');
    expect(sp301.length).toBeGreaterThan(0);
  });

  it('recognizes widgets defined with quoted or bare names and $/_/@ params', () => {
    const widgetFile = [
      ':: Widgets [widget]',
      "{widget 'hello' @name}Hello{/widget}",
      '{widget bye $who}Bye{/widget}',
      '{widget "temp" _name}Temp{/widget}',
    ].join('\n');
    const storyFile = ':: Start\n{hello "Sam"}\n{bye "Sam"}\n{temp "Sam"}\n{temp}';
    const workspace = createWorkspaceFrom(
      { name: 'widgets.tw', content: widgetFile },
      { name: 'story.tw', content: storyFile },
    );
    const diags = computeDiagnostics('file:///story.tw', workspace);
    expect(diags.filter(d => d.code === 'SP100')).toHaveLength(0);
    const sp301 = diags.filter(d => d.code === 'SP301');
    expect(sp301).toHaveLength(1);
    expect(sp301[0].range.start.line).toBe(4);
  });

  it('resolves widget invocations case-insensitively', () => {
    const widgetFile = ':: Widgets [widget]\n{widget "Hello" @name}Hello{/widget}';
    const storyFile = ':: Start\n{hello "Sam"}\n{HELLO}';
    const workspace = createWorkspaceFrom(
      { name: 'widgets.tw', content: widgetFile },
      { name: 'story.tw', content: storyFile },
    );
    const diags = computeDiagnostics('file:///story.tw', workspace);
    expect(diags.filter(d => d.code === 'SP100')).toHaveLength(0);
    const sp301 = diags.filter(d => d.code === 'SP301');
    expect(sp301).toHaveLength(1);
    expect(sp301[0].range.start.line).toBe(2);
    const widgetDiags = computeDiagnostics('file:///widgets.tw', workspace);
    expect(widgetDiags.filter(d => d.code === 'SP303')).toHaveLength(0);
  });

  it('does not produce SP301 when widget arg count matches', () => {
    const widgetFile = `:: Widgets [widget]\n{widget "greet" @name}\nHello {@name}\n{/widget}`;
    const storyFile = `:: Start\n{greet "World"}`;
    const workspace = createWorkspaceFrom(
      { name: 'widgets.tw', content: widgetFile },
      { name: 'story.tw', content: storyFile },
    );
    const diags = computeDiagnostics('file:///story.tw', workspace);
    const sp301 = diags.filter(d => d.code === 'SP301');
    expect(sp301).toHaveLength(0);
  });

  it('diagnostics have correct severity from getSeverity', () => {
    const workspace = createWorkspaceFromFixture('errors.tw');
    const diags = computeDiagnostics('file:///errors.tw', workspace);
    for (const d of diags) {
      if (d.code === 'SP100') expect(d.severity).toBe('warning');
      if (d.code === 'SP101') expect(d.severity).toBe('error');
      if (d.code === 'SP104') expect(d.severity).toBe('error');
      if (d.code === 'SP107') expect(d.severity).toBe('error');
    }
  });

  it('diagnostics have source set to "spindle"', () => {
    const workspace = createWorkspaceFromFixture('errors.tw');
    const diags = computeDiagnostics('file:///errors.tw', workspace);
    for (const d of diags) {
      expect(d.source).toBe('spindle');
    }
  });

  it('produces SP114 for too many children', () => {
    const text = `:: TestPassage
{if $x}
{else}
{else}
{/if}`;
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
    const diags = computeDiagnostics('file:///test.tw', workspace);
    const sp114 = diags.filter(d => d.code === 'SP114');
    expect(sp114.length).toBeGreaterThan(0);
    expect(sp114[0].message).toContain('else');
  });

  it('produces SP115 for too few children', () => {
    // switch requires at least 1 case child
    const text = `:: TestPassage
{switch $x}
plain text only
{/switch}`;
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
    const diags = computeDiagnostics('file:///test.tw', workspace);
    const sp115 = diags.filter(d => d.code === 'SP115');
    expect(sp115.length).toBeGreaterThan(0);
    expect(sp115[0].message).toContain('case');
  });

  it('produces SP203 for undeclared transient variable', () => {
    const text = `:: StoryTransients\n%known = 1\n\n:: Start\n{set %unknown = 1}`;
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
    const diags = computeDiagnostics('file:///test.tw', workspace);
    const sp203 = diags.filter(d => d.code === 'SP203');
    expect(sp203.length).toBeGreaterThan(0);
    expect(sp203[0].message).toContain('%unknown');
  });

  it('does not flag declared transient variables as SP203', () => {
    const text = `:: StoryTransients\n%npcList = []\n\n:: Start\n{set %npcList = [1]}`;
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
    const diags = computeDiagnostics('file:///test.tw', workspace);
    const sp203 = diags.filter(d => d.code === 'SP203');
    expect(sp203).toHaveLength(0);
  });

  it('produces SP204 for null value in StoryVariables', () => {
    const text = `:: StoryVariables\n$health = 100\n$bad = null\n\n:: Start\nHello`;
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
    const diags = computeDiagnostics('file:///test.tw', workspace);
    const sp204 = diags.filter(d => d.code === 'SP204');
    expect(sp204).toHaveLength(1);
    expect(sp204[0].message).toContain('$bad');
    expect(sp204[0].message).toContain('null');
    expect(sp204[0].severity).toBe('error');
  });

  it('produces SP204 for null value in StoryTransients', () => {
    const text = `:: StoryTransients\n%ok = 0\n%bad = null\n\n:: Start\nHello`;
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
    const diags = computeDiagnostics('file:///test.tw', workspace);
    const sp204 = diags.filter(d => d.code === 'SP204');
    expect(sp204).toHaveLength(1);
    expect(sp204[0].message).toContain('%bad');
    expect(sp204[0].severity).toBe('error');
  });

  it('does not produce SP200 for variable declared as null (SP204 instead)', () => {
    const text = `:: StoryVariables\n$bad = null\n\n:: Start\n{set $bad = 1}`;
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
    const diags = computeDiagnostics('file:///test.tw', workspace);
    const sp200 = diags.filter(d => d.code === 'SP200');
    expect(sp200).toHaveLength(0);
    const sp204 = diags.filter(d => d.code === 'SP204');
    expect(sp204).toHaveLength(1);
  });

  it('does not produce SP204 for valid default values', () => {
    const text = `:: StoryVariables\n$a = 0\n$b = ""\n$c = false\n\n:: Start\nHello`;
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
    const diags = computeDiagnostics('file:///test.tw', workspace);
    const sp204 = diags.filter(d => d.code === 'SP204');
    expect(sp204).toHaveLength(0);
  });

  it('does not produce SP203 when no StoryTransients passage exists', () => {
    const text = `:: Start\n{set %whatever = 1}`;
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
    const diags = computeDiagnostics('file:///test.tw', workspace);
    const sp203 = diags.filter(d => d.code === 'SP203');
    expect(sp203).toHaveLength(0);
  });

  it('handles multi-file workspace', () => {
    const file1 = `:: StoryVariables\n$x = 1\n\n:: Start\n[[Page2]]\n`;
    const file2 = `:: Page2\nHello\n`;
    const workspace = createWorkspaceFrom(
      { name: 'file1.tw', content: file1 },
      { name: 'file2.tw', content: file2 },
    );
    const diags1 = computeDiagnostics('file:///file1.tw', workspace);
    const sp300 = diags1.filter(d => d.code === 'SP300');
    // Page2 exists in file2, so no broken link
    expect(sp300).toHaveLength(0);
  });

  it('produces SP108 when macro expects no arguments but receives some', () => {
    // {else} takes no arguments
    const text = `:: TestPassage\n{if $x}ok{else "extra"}{/if}`;
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
    const diags = computeDiagnostics('file:///test.tw', workspace);
    const sp108 = diags.filter(d => d.code === 'SP108');
    expect(sp108.length).toBeGreaterThan(0);
  });
});

describe('error handling', () => {
  it('handles malformed input gracefully', () => {
    expect(() => parseMacros('{{{unclosed')).not.toThrow();
  });

  it('parseMacros handles deeply nested braces', () => {
    expect(() => parseMacros('{{{{{{{{{{foo}}}}}}}}}}')).not.toThrow();
  });

  it('parseMacros handles empty string', () => {
    const result = parseMacros('');
    expect(result).toHaveLength(0);
  });

  it('parseMacros handles string with only whitespace', () => {
    const result = parseMacros('   \n\n\t  ');
    expect(result).toHaveLength(0);
  });

  it('handles empty document', () => {
    const workspace = createWorkspaceFrom({ name: 'empty.tw', content: '' });
    const diags = computeDiagnostics('file:///empty.tw', workspace);
    expect(diags).toHaveLength(0);
  });

  it('handles document with no passages', () => {
    const workspace = createWorkspaceFrom({ name: 'nopsg.tw', content: 'just plain text' });
    const diags = computeDiagnostics('file:///nopsg.tw', workspace);
    expect(diags).toHaveLength(0);
  });

  it('handles document not in workspace', () => {
    const workspace = createWorkspaceFrom({ name: 'a.tw', content: ':: Start\nhi' });
    const diags = computeDiagnostics('file:///nonexistent.tw', workspace);
    expect(diags).toHaveLength(0);
  });

  it('handles very long lines without crashing', () => {
    const longLine = 'a'.repeat(10000);
    const text = `:: Start\n${longLine}`;
    const workspace = createWorkspaceFrom({ name: 'long.tw', content: text });
    expect(() => computeDiagnostics('file:///long.tw', workspace)).not.toThrow();
  });

  it('handles document with many macros', () => {
    const lines = [':: Start'];
    for (let i = 0; i < 100; i++) {
      lines.push(`{set $x${i} = ${i}}`);
    }
    const text = lines.join('\n');
    const workspace = createWorkspaceFrom({ name: 'many.tw', content: text });
    expect(() => computeDiagnostics('file:///many.tw', workspace)).not.toThrow();
  });

  it('MacroRegistry.loadBuiltins gracefully handles missing package', () => {
    const registry = new MacroRegistry();
    expect(() => registry.loadBuiltins()).not.toThrow();
    // Should still be functional (empty or with builtins from the package if available)
    expect(registry.getAllMacros()).toBeDefined();
  });
});

describe('SP205: temporary assigned inside {for}', () => {
  function sp205(text: string) {
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
    return computeDiagnostics('file:///test.tw', workspace).filter(d => d.code === 'SP205');
  }

  it('flags {computed _x} inside {for} that is read in the loop body', () => {
    const diags = sp205([
      ':: Start',
      '{for @i of [1, 2, 3]}',
      '{computed _b = @i * 2}',
      '{_b}',
      '{/for}',
    ].join('\n'));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('warning');
    expect(diags[0].message).toContain("'_b'");
    expect(diags[0].message).toContain("'@b'");
    expect(diags[0].range).toEqual({
      start: { line: 2, character: 10 },
      end: { line: 2, character: 12 },
    });
  });

  it('flags {set _x} inside {for} nested in a widget and an {if}', () => {
    const diags = sp205([
      ':: Widgets [widget]',
      '{widget "ResourceCost" @costs @current}',
      '{set _keys = Object.keys(@costs)}',
      '{for @key of _keys}',
      '{if @key}',
      '{set _required = @costs[@key]}',
      '{set _have = @current[@key] ?? 0}',
      '<span class="{if _have < _required}insufficient{/if}">{_have}/{_required}</span>',
      '{/if}',
      '{/for}',
      '{/widget}',
    ].join('\n'));
    expect(diags.map(d => d.message.match(/'_(\w+)'/)![1])).toEqual(['required', 'have']);
    expect(diags[0].range.start).toEqual({ line: 5, character: 5 });
  });

  it('flags each temporary of a multi-assignment {set}', () => {
    const diags = sp205([
      ':: Start',
      '{for @item of $list}',
      '{set _a = @item.a, _b = @item.b}',
      '{_a} {_b}',
      '{/for}',
    ].join('\n'));
    expect(diags).toHaveLength(2);
    expect(diags[0].range.start.character).toBe(5);
    expect(diags[1].range.start.character).toBe(19);
  });

  it('flags a temporary read before its assignment (previous-item pattern)', () => {
    const diags = sp205([
      ':: Start',
      '{for @item of $list}',
      '{if @item.group !== _prev}<h3>{@item.group}</h3>{/if}',
      '{set _prev = @item.group}',
      '{/for}',
    ].join('\n'));
    expect(diags).toHaveLength(1);
  });

  it('does not flag @locals inside {for}', () => {
    const diags = sp205([
      ':: Start',
      '{for @i of [1, 2, 3]}',
      '{computed @b = @i * 2}',
      '{set @c = @b + 1}',
      '{@b} {@c}',
      '{/for}',
    ].join('\n'));
    expect(diags).toHaveLength(0);
  });

  it('does not flag temporaries assigned outside any loop', () => {
    const diags = sp205([
      ':: Start',
      '{computed _total = $list.length}',
      '{set _label = "Items"}',
      '{for @item of $list}{_label}: {@item}{/for}',
      '{_total}',
    ].join('\n'));
    expect(diags).toHaveLength(0);
  });

  it('does not flag a temporary that is only read after the loop', () => {
    const diags = sp205([
      ':: Start',
      '{for @item of $list}',
      '{if @item.broken}{set _anyBroken = true}{/if}',
      '{/for}',
      '{if _anyBroken}Something is broken.{/if}',
    ].join('\n'));
    expect(diags).toHaveLength(0);
  });

  it('does not flag accumulators', () => {
    const diags = sp205([
      ':: Start',
      '{set _total = 0, _count = 0, _names = ""}',
      '{for @item of $list}',
      '{set _total = _total + @item.cost}',
      '{set _count += 1}',
      '{set _names = `${_names} ${@item.name}`}',
      'Running: {_total} {_count} {_names}',
      '{/for}',
    ].join('\n'));
    expect(diags).toHaveLength(0);
  });

  it('does not flag assignments inside {link} or {button} bodies', () => {
    const diags = sp205([
      ':: Start',
      '{for @item of $list}',
      '{link "Pick"}{set _picked = @item}{/link}',
      '{button "Choose"}{set _chosen = @item}{/button}',
      '{if _picked === @item}picked{/if}{if _chosen === @item}chosen{/if}',
      '{/for}',
    ].join('\n'));
    expect(diags).toHaveLength(0);
  });

  it('ignores temporaries inside strings and comparisons', () => {
    const diags = sp205([
      ':: Start',
      '{for @item of $list}',
      '{set $msg = "_x = 1"}',
      '{set $same = _y == @item}',
      '{computed @range = Array.from({length: 3}, (_, i) => i)}',
      '{_x} {_y}',
      '{/for}',
    ].join('\n'));
    expect(diags).toHaveLength(0);
  });

  it('flags a temporary assigned in a nested loop and read in that loop', () => {
    const diags = sp205([
      ':: Start',
      '{for @row of $rows}',
      '{for @cell of @row}',
      '{computed _value = @cell * 2}{_value}',
      '{/for}',
      '{/for}',
    ].join('\n'));
    expect(diags).toHaveLength(1);
    expect(diags[0].range.start.line).toBe(3);
  });
});

describe('SP206: member access on an array variable', () => {
  function sp206(text: string) {
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
    return computeDiagnostics('file:///test.tw', workspace).filter(d => d.code === 'SP206');
  }

  it('flags a non-array property on a variable declared as []', () => {
    const diags = sp206([
      ':: StoryVariables',
      '$flags = []',
      '',
      ':: Start',
      '{if $flags.discovered_corruption}Corrupted{/if}',
    ].join('\n'));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('warning');
    expect(diags[0].message).toContain('$flags.discovered_corruption');
    expect(diags[0].message).toContain('$flags.includes("discovered_corruption")');
    expect(diags[0].range).toEqual({
      start: { line: 4, character: 4 },
      end: { line: 4, character: 32 },
    });
  });

  it('flags assignments to a named property of an array', () => {
    const diags = sp206([
      ':: StoryVariables',
      '$seen = ["intro"]',
      '',
      ':: Start',
      '{set $seen.cave = true}',
    ].join('\n'));
    expect(diags).toHaveLength(1);
  });

  it('flags transient arrays declared in StoryTransients', () => {
    const diags = sp206([
      ':: StoryTransients',
      '%queue = [1, 2]',
      '',
      ':: Start',
      '{%queue.first}',
    ].join('\n'));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('StoryTransients');
  });

  it('does not flag array methods and properties', () => {
    const diags = sp206([
      ':: StoryVariables',
      '$flags = []',
      '',
      ':: Start',
      '{if $flags.includes("x")}x{/if}',
      '{$flags.length}',
      '{print $flags.map(f => f.toUpperCase()).join(", ")}',
      '{print $flags.at(-1)}',
      '{print $flags.toSorted()}',
    ].join('\n'));
    expect(diags).toHaveLength(0);
  });

  it('does not flag objects, strings or non-literal defaults', () => {
    const diags = sp206([
      ':: StoryVariables',
      '$pc = { name: "Hero", tags: [] }',
      '$label = "[x]"',
      '$count = [1, 2].length',
      '',
      ':: Start',
      '{$pc.name} {$pc.anything} {$label.foo} {$count.bar} {$pc.tags.foo}',
    ].join('\n'));
    expect(diags).toHaveLength(0);
  });
});

describe('SP302: {include} of a [widget] passage', () => {
  const widgets = [
    ':: ActResist [widget nobr]',
    '{widget "ActResist"}You resist.{/widget}',
    '',
    ':: Helpers [widget]',
    '{widget "greet" @name}Hello {@name}{/widget}',
    '{widget "bye"}Bye{/widget}',
    '',
    ':: Normal',
    'Plain text.',
    '',
    ':: Effects [widget]',
    '{do}applyEffects();{/do}',
    '',
    ':: Bare [widget]',
    '{widget bareName}bare{/widget}',
  ].join('\n');

  function sp302(story: string) {
    const workspace = createWorkspaceFrom(
      { name: 'widgets.tw', content: widgets },
      { name: 'story.tw', content: story },
    );
    return computeDiagnostics('file:///story.tw', workspace).filter(d => d.code === 'SP302');
  }

  it('flags a quoted include of a widget passage', () => {
    const diags = sp302(':: Start\n{include "Helpers"}');
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('warning');
    expect(diags[0].message).toContain('"Helpers"');
    expect(diags[0].message).toContain('{greet}, {bye}');
  });

  it('flags a bare-name include, which Spindle resolves by fallback', () => {
    const diags = sp302(":: Start\n{include ActResist}\n{include 'ActResist' inline}");
    expect(diags).toHaveLength(2);
    expect(diags[0].message).toContain('{ActResist}');
  });

  it('flags widget passages whose definitions use a bare name', () => {
    const diags = sp302(':: Start\n{include "Bare"}');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('{bareName}');
  });

  it('does not flag a [widget] passage that defines no widgets', () => {
    // Its content renders like any other passage's when included.
    const diags = sp302(':: Start\n{include "Effects"}');
    expect(diags).toHaveLength(0);
  });

  it('does not flag includes of ordinary, missing or dynamic passages', () => {
    const diags = sp302([
      ':: Start',
      '{include "Normal"}',
      '{include "Missing"}',
      '{include $encounter.prosePassage}',
      '{include _name}',
      '{include `${$prefix}Resist`}',
    ].join('\n'));
    expect(diags).toHaveLength(0);
  });
});

describe('resolveIncludeTarget', () => {
  it('resolves string literals and bare names', () => {
    expect(resolveIncludeTarget('"Passage Name"')).toBe('Passage Name');
    expect(resolveIncludeTarget("'Passage'")).toBe('Passage');
    expect(resolveIncludeTarget('`Passage`')).toBe('Passage');
    expect(resolveIncludeTarget('"Say \\"hi\\""')).toBe('Say "hi"');
    expect(resolveIncludeTarget('ActResist')).toBe('ActResist');
    expect(resolveIncludeTarget('My Passage')).toBe('My Passage');
    expect(resolveIncludeTarget('"Passage" inline')).toBe('Passage');
  });

  it('returns null for dynamic targets', () => {
    expect(resolveIncludeTarget('$name')).toBeNull();
    expect(resolveIncludeTarget('_name')).toBeNull();
    expect(resolveIncludeTarget('@name')).toBeNull();
    expect(resolveIncludeTarget('%name')).toBeNull();
    expect(resolveIncludeTarget('"Act" + $suffix')).toBeNull();
    expect(resolveIncludeTarget('`${$prefix}Act`')).toBeNull();
    expect(resolveIncludeTarget('pick()')).toBeNull();
    expect(resolveIncludeTarget('visited')).toBeNull();
    expect(resolveIncludeTarget('')).toBeNull();
  });
});

describe('SP303: unused widget', () => {
  it('reports a widget that is never invoked, as a hint on its definition', () => {
    const workspace = createWorkspaceFrom(
      { name: 'widgets.tw', content: ':: W [widget]\n{widget "used"}u{/widget}\n{widget "unused"}x{/widget}' },
      { name: 'story.tw', content: ':: Start\n{used}' },
    );
    const diags = computeDiagnostics('file:///widgets.tw', workspace).filter(d => d.code === 'SP303');
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('hint');
    expect(diags[0].message).toContain('"unused"');
    expect(diags[0].range.start).toEqual({ line: 2, character: 0 });

    const storyDiags = computeDiagnostics('file:///story.tw', workspace).filter(d => d.code === 'SP303');
    expect(storyDiags).toHaveLength(0);
  });

  it('counts case-insensitive, nested, prefixed and block invocations', () => {
    const workspace = createWorkspaceFrom(
      {
        name: 'widgets.tw',
        content: [
          ':: W [widget]',
          '{widget "Greet" @name}Hi {@name}{/widget}',
          '{widget "inner"}in{/widget}',
          '{widget "outer"}{inner}{/widget}',
          '{widget "Box"}<div>{@children}</div>{/widget}',
          '{widget "styled"}s{/widget}',
        ].join('\n'),
      },
      { name: 'story.tw', content: ':: Start\n{greet "x"} {outer} {Box}content{/Box} {.red styled}' },
    );
    const diags = computeDiagnostics('file:///widgets.tw', workspace).filter(d => d.code === 'SP303');
    expect(diags).toHaveLength(0);
  });

  it('does not count {include} of the widget passage as an invocation', () => {
    const workspace = createWorkspaceFrom(
      { name: 'widgets.tw', content: ':: ActKiss [widget]\n{widget "ActKiss"}kiss{/widget}' },
      { name: 'story.tw', content: ':: Start\n{include "ActKiss"}' },
    );
    const codes = [
      ...computeDiagnostics('file:///widgets.tw', workspace),
      ...computeDiagnostics('file:///story.tw', workspace),
    ].map(d => d.code);
    expect(codes).toContain('SP303');
    expect(codes).toContain('SP302');
  });
});
