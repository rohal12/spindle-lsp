import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import type { DiagnosticOptions } from '../../src/plugins/diagnostics.js';

function createWorkspaceFrom(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const model = new WorkspaceModel();
  const fileContents = new Map<string, string>();
  for (const f of files) {
    fileContents.set(`file:///${f.name}`, f.content);
  }
  model.initialize(fileContents);
  return model;
}

function diagnose(text: string, options?: DiagnosticOptions) {
  const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
  return computeDiagnostics('file:///test.tw', workspace, options);
}

function codes(text: string, code: string, options?: DiagnosticOptions) {
  return diagnose(text, options).filter(d => d.code === code);
}

describe('SP101: container nesting and passage boundaries', () => {
  it('reports containers that would pair across passages', () => {
    const sp101 = codes(':: Start\n{if true}\n:: Other\n{/if}', 'SP101');
    expect(sp101).toHaveLength(2);
    expect(sp101.map(d => d.range.start.line).sort()).toEqual([1, 3]);
  });

  it('reports crossed containers in one passage', () => {
    const sp101 = codes(':: Start\n{if true}{for @x of []}{/if}{/for}', 'SP101');
    expect(sp101).toHaveLength(2);
    expect(sp101.some(d => d.message.includes('no matching {/for}'))).toBe(true);
    expect(sp101.some(d => d.message.includes('no matching {for}'))).toBe(true);
  });

  it('accepts properly nested containers', () => {
    const sp101 = codes(':: Start\n{if true}{for @x of []}{/for}{/if}\n:: Other\n{if false}x{/if}', 'SP101');
    expect(sp101).toHaveLength(0);
  });
});

describe('argument validation with receiver parameters', () => {
  it('validates macros that follow a receiver macro', () => {
    const sp109 = codes(':: Start\n{textbox "$x" ""}\n{goto}', 'SP109');
    expect(sp109).toHaveLength(1);
    expect(sp109[0].message).toContain('{goto}');
  });

  it('accepts the documented form controls', () => {
    const text = [
      ':: Start',
      '{textbox $name}',
      '{textbox "$name" "Enter your name"}',
      '{numberbox $health}',
      '{textarea $notes "Enter notes here"}',
      '{checkbox $has_key "Take the key?"}',
      '{radiobutton $class "warrior" "Warrior"}',
      '{listbox "$weapon"}{option "Sword"}{/listbox}',
      '{cycle $stance}{option "Offensive"}{/cycle}',
    ].join('\n');
    const argDiags = diagnose(text).filter(d => ['SP108', 'SP109', 'SP111'].includes(d.code));
    expect(argDiags).toEqual([]);
  });

  it('rejects a receiver that is not a variable', () => {
    const sp109 = codes(':: Start\n{textbox 42 "x"}', 'SP109');
    expect(sp109).toHaveLength(1);
    expect(sp109[0].message).toContain('receiver');
  });

  it('isolates a malformed custom parameter schema to its own macro', () => {
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: ':: Start\n{broken 1}\n{goto}' });
    workspace.macros.loadSupplements({ broken: { name: 'broken', parameters: ['nosuchtype'] } });
    const diags = computeDiagnostics('file:///test.tw', workspace);
    expect(diags.filter(d => d.code === 'SP109' && d.message.includes('{goto}'))).toHaveLength(1);
  });
});

describe('{include} arguments', () => {
  const target = '\n:: Target\nText';

  it('accepts a trailing inline modifier', () => {
    const diags = diagnose(`:: Start\n{include "Target" inline}${target}`);
    expect(diags.filter(d => ['SP109', 'SP111'].includes(d.code))).toEqual([]);
  });

  it('accepts a leading inline modifier', () => {
    const diags = diagnose(`:: Start\n{include inline "Target"}${target}`);
    expect(diags.filter(d => ['SP109', 'SP111'].includes(d.code))).toEqual([]);
  });

  it('accepts a dynamic expression target containing whitespace', () => {
    const text = `:: StoryVariables\n$suffix = "get"\n\n:: Start\n{include "Tar" + $suffix}${target}`;
    const diags = diagnose(text);
    expect(diags.filter(d => ['SP109', 'SP111'].includes(d.code))).toEqual([]);
  });

  it('still reports a missing target', () => {
    expect(codes(':: Start\n{include}', 'SP109')).toHaveLength(1);
    expect(codes(':: Start\n{include inline}', 'SP109')).toHaveLength(1);
  });
});
