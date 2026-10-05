import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceModel, type WorkspaceModelConfig } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import type { Diagnostic } from '../../src/core/types.js';

function diagnose(content: string, config?: WorkspaceModelConfig): Diagnostic[] {
  const workspace = new WorkspaceModel(config);
  workspace.initialize(new Map([['file:///test.tw', content]]));
  return computeDiagnostics('file:///test.tw', workspace);
}

function codes(diags: Diagnostic[]): string[] {
  return diags.map(d => d.code);
}

describe('{next} branches of {timed}', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A project whose installed Spindle ships the given macro registry. */
  function projectWithRegistry(entries: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), 'spindle-lsp-timed-'));
    dirs.push(root);
    const pkg = join(root, 'node_modules', '@rohal12', 'spindle', 'dist', 'pkg');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'macro-registry.json'), JSON.stringify(entries));
    return root;
  }

  const timedStory = ':: Start\n{timed 1s}\nFirst\n{next 2s}\nSecond\n{next}\nThird\n{/timed}\n';

  it('accepts {next} with and without a delay inside {timed}', () => {
    expect(diagnose(timedStory)).toEqual([]);
  });

  it('accepts {next} inside {timed} when builtins come from the project\'s Spindle', () => {
    const root = projectWithRegistry([
      { name: 'timed', block: true, subMacros: ['next'], interpolate: true, source: 'builtin' },
      { name: 'for', block: true, subMacros: [], interpolate: true, merged: true, source: 'builtin' },
    ]);
    expect(diagnose(timedStory, { workspaceRoot: root })).toEqual([]);
  });

  it('accepts {next} inside {timed} when the project\'s registry lists no macros', () => {
    const root = projectWithRegistry([]);
    expect(diagnose(timedStory, { workspaceRoot: root })).toEqual([]);
  });

  it('accepts {timed} without a delay, which shows its first section at once', () => {
    // Spindle's Timed.tsx: branch.rawArgs ? parseDelay(branch.rawArgs) : 0
    expect(diagnose(':: Start\n{timed}\nA\n{next 1s}\nB\n{/timed}\n')).toEqual([]);
  });

  it('rejects {timed} with more than one argument', () => {
    expect(codes(diagnose(':: Start\n{timed 1s 2s}\nA\n{/timed}\n'))).toEqual(['SP111']);
  });

  it('rejects {next} with more than one argument', () => {
    const diags = diagnose(':: Start\n{timed 1s}\nFirst\n{next 2s 3s}\nSecond\n{/timed}\n');
    expect(codes(diags)).toEqual(['SP111']);
  });

  it('flags {next} outside {timed}', () => {
    const diags = diagnose(':: Start\n{next 2s}\n');
    expect(codes(diags)).toEqual(['SP107']);
    expect(diags[0].message).toContain('{timed}');
  });

  it('flags {next} in a {for} loop, which Spindle rejects', () => {
    // Spindle's AST builder only accepts {next} as a {timed} branch:
    // "{next} without matching {timed}".
    const diags = diagnose(':: Start\n{for @x of [1, 2]}\n{next}\n{/for}\n');
    expect(codes(diags)).toEqual(['SP107']);
    expect(diags[0].message).toContain('{timed}');
  });
});

describe('branch macros sit directly inside their parent', () => {
  // Spindle's buildAST only accepts a branch macro when its parent is the
  // innermost open block: "{next} without matching {timed}".
  const vars = ':: StoryVariables\n$x = 1\n';

  it('flags {next} inside an {if} within {timed}', () => {
    const diags = diagnose(`${vars}:: Start\n{timed 1s}\nA\n{if $x}\n{next 1s}\n{/if}\n{/timed}\n`);
    expect(codes(diags)).toEqual(['SP107']);
    expect(diags[0].message).toContain('{timed}');
    expect(diags[0].message).toContain('{if}');
    expect(diags[0].range.start.line).toBe(6);
  });

  it('flags {else} and {elseif} inside a {for} within {if}', () => {
    const diags = diagnose(`${vars}:: Start\n{if $x}\n{for @i of [1]}\n{elseif $x}\n{else}\n{/for}\n{/if}\n`);
    expect(codes(diags)).toEqual(['SP107', 'SP107']);
    expect(diags.every(d => d.message.includes('{for}'))).toBe(true);
  });

  it('flags {case} and {default} nested in another container within {switch}', () => {
    const diags = diagnose(`${vars}:: Start\n{switch $x}\n{case 1}\none\n{do}\n{case 2}\n{default}\n{/do}\n{/switch}\n`);
    expect(codes(diags)).toEqual(['SP107', 'SP107']);
  });

  it('flags a branch inside a block widget invocation', () => {
    const widgets = ':: Widgets [widget]\n{widget "box"}\n<div>{@children}</div>\n{/widget}\n';
    const diags = diagnose(`${vars}${widgets}:: Start\n{if $x}\n{box}\n{else}\n{/box}\n{/if}\n`);
    expect(codes(diags)).toEqual(['SP107']);
    expect(diags[0].message).toContain('{box}');
  });

  it('accepts branches of nested blocks of the same kind', () => {
    expect(diagnose(`${vars}:: Start\n{if $x}\n{if $x}\na\n{else}\nb\n{/if}\n{else}\nc\n{/if}\n`)).toEqual([]);
    expect(diagnose(`${vars}:: Start\n{timed 1s}\nA\n{timed 1s}\nB\n{next 1s}\nC\n{/timed}\n{next 1s}\nD\n{/timed}\n`)).toEqual([]);
  });

  it('accepts branches after a closed nested block', () => {
    expect(diagnose(`${vars}:: Start\n{if $x}\n{for @i of [1]}\n{@i}\n{/for}\n{elseif $x}\n{do}d{/do}\n{else}\nc\n{/if}\n`)).toEqual([]);
    expect(diagnose(`${vars}:: Start\n{switch $x}\n{case 1}\n{if $x}a{else}b{/if}\n{default}\nc\n{/switch}\n`)).toEqual([]);
  });

  it('flags {option} inside another block within {listbox}, which Spindle ignores', () => {
    // Spindle's extractOptions only reads the listbox's direct children.
    const diags = diagnose(`${vars}:: Start\n{listbox "$x"}\n{option "a"}\n{if $x}\n{option "b"}\n{/if}\n{/listbox}\n`);
    expect(codes(diags)).toEqual(['SP107']);
    expect(diags[0].range.start.line).toBe(6);
  });
});

describe('container child constraints ignore capitalization', () => {
  it('counts an upper-case {CASE} towards {switch}\'s minimum', () => {
    expect(diagnose(':: Start\n{switch 1}\n{CASE 1}\none\n{/switch}\n')).toEqual([]);
  });

  it('accepts mixed-case parents and children', () => {
    expect(diagnose(':: Start\n{SWITCH 1}\n{Case 1}\none\n{Default}\nother\n{/Switch}\n')).toEqual([]);
  });

  it('counts mixed-case children towards maximums', () => {
    const ifDiags = diagnose(':: Start\n{if true}\na\n{ELSE}\nb\n{else}\nc\n{/if}\n');
    expect(codes(ifDiags)).toEqual(['SP114']);
    expect(ifDiags[0].message).toContain('found 2');

    const switchDiags = diagnose(':: Start\n{switch 1}\n{case 1}\na\n{Default}\nb\n{DEFAULT}\nc\n{/switch}\n');
    expect(codes(switchDiags)).toEqual(['SP114']);
    expect(switchDiags[0].message).toContain('found 2');
  });

  it('matches constraints whose configured name is not lower-case', () => {
    const workspace = new WorkspaceModel();
    workspace.macros.loadConfig({ switch: { children: [{ name: 'Case', min: 2 }] } });
    workspace.initialize(new Map([['file:///test.tw', ':: Start\n{switch 1}\n{case 1}\na\n{CASE 2}\nb\n{/switch}\n']]));
    expect(computeDiagnostics('file:///test.tw', workspace)).toEqual([]);
  });

  it('still flags a mixed-case child outside its parent', () => {
    expect(codes(diagnose(':: Start\n{CASE 1}\n'))).toEqual(['SP107']);
  });
});

describe('block widget invocations are containers', () => {
  const widgets = ':: Widgets [widget]\n{widget "box"}\n<div>{@children}</div>\n{/widget}\n{widget "greet"}\nHi\n{/widget}\n\n';

  it('accepts a closed block widget invocation', () => {
    expect(diagnose(`${widgets}:: Start\n{greet}\n{box}\nHello\n{/box}\n`)).toEqual([]);
  });

  it('flags a block widget invocation without its closing tag', () => {
    const diags = diagnose(`${widgets}:: Start\n{greet}\n{box}\nHello\n`);
    expect(codes(diags)).toEqual(['SP101']);
    expect(diags[0].message).toBe('Malformed container: no matching {/box}');
    expect(diags[0].range.start.line).toBe(10);
  });

  it('flags an unmatched closing tag of a block widget', () => {
    const diags = diagnose(`${widgets}:: Start\n{greet}\n{box}Hello{/box}\n{/Box}\n`);
    expect(codes(diags)).toEqual(['SP101']);
    expect(diags[0].range.start.line).toBe(11);
    expect(diags[0].message).toBe('Malformed container: no matching {Box}');
  });

  it('does not pair a block widget across passages', () => {
    const diags = diagnose(`${widgets}:: Start\n{greet}\n{box}\n:: Other\n{/box}\n`);
    expect(codes(diags)).toEqual(['SP101', 'SP101']);
  });

  it('does not make inline widgets containers', () => {
    expect(diagnose(`${widgets}:: Start\n{box}{greet}{/box}\n`)).toEqual([]);
    const diags = diagnose(`${widgets}:: Start\n{box}{greet}{/box}\nHello\n{/greet}\n`);
    expect(codes(diags)).toEqual(['SP104']);
    expect(diags[0].message).toContain('greet');
  });
});
