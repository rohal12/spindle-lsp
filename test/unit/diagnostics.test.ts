import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
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

  it('produces SP200 for undeclared variable', () => {
    const workspace = createWorkspaceFromFixture('variables.tw');
    const diags = computeDiagnostics('file:///variables.tw', workspace);
    const sp200 = diags.filter(d => d.code === 'SP200');
    expect(sp200.length).toBeGreaterThan(0);
    expect(sp200.some(d => d.message.includes('$unknown'))).toBe(true);
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
