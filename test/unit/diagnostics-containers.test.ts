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
