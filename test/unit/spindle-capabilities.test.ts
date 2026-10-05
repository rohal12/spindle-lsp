import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CAPABILITIES,
  capabilitiesForVersion,
  parseSpindleVersion,
  readInstalledSpindleVersion,
  resolveSpindleCapabilities,
} from '../../src/core/workspace/spindle-capabilities.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { INSTALLED_CAPABILITIES, INSTALLED_SPINDLE_VERSION } from '../helpers/spindle-version.js';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** A project directory with `version` of Spindle "installed" (or none). */
function project(version?: string, nested = false): string {
  const root = mkdtempSync(join(tmpdir(), 'spindle-caps-'));
  roots.push(root);
  if (version !== undefined) {
    const pkg = join(root, 'node_modules', '@rohal12', 'spindle');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@rohal12/spindle', version }));
  }
  if (!nested) return root;
  const sub = join(root, 'story', 'src');
  mkdirSync(sub, { recursive: true });
  return sub;
}

const uri = 'file:///test.tw';
function diagnose(root: string | undefined, text: string, file = uri) {
  const workspace = new WorkspaceModel(root ? { workspaceRoot: root } : undefined);
  workspace.initialize(new Map([[file, text]]));
  return { workspace, diagnostics: computeDiagnostics(file, workspace) };
}

describe('SpindleCapabilities', () => {
  it('gates each behavior at the release that introduced it', () => {
    const at = (v: string) => {
      const c = capabilitiesForVersion(v);
      return [c.supported, c.executableRefsOnly, c.primitiveMembers, c.linkQuoteEscapes, c.rawDoBodies];
    };
    expect(at('0.42.0')).toEqual([false, false, false, false, false]);
    expect(at('0.43.0')).toEqual([true, false, false, false, false]);
    expect(at('0.45.1')).toEqual([true, false, false, false, false]);
    expect(at('0.50.0')).toEqual([true, false, false, false, false]);
    expect(at('0.50.1')).toEqual([true, true, false, false, true]);
    expect(at('0.51.0')).toEqual([true, true, false, false, true]);
    expect(at('0.51.1')).toEqual([true, true, true, true, true]);
    expect(at('0.51.3')).toEqual([true, true, true, true, true]);
    expect(at('1.0.0')).toEqual([true, true, true, true, true]);
  });

  it('compares numerically and ignores a prerelease suffix', () => {
    expect(parseSpindleVersion('0.100.2')).toEqual([0, 100, 2]);
    expect(capabilitiesForVersion('0.9.0').supported).toBe(false);
    expect(capabilitiesForVersion('0.100.0').primitiveMembers).toBe(true);
    expect(capabilitiesForVersion('0.51.1-beta.2').version).toBe('0.51.1');
    expect(parseSpindleVersion('latest')).toBeUndefined();
    expect(capabilitiesForVersion('latest')).toBe(DEFAULT_CAPABILITIES);
  });

  it('defaults to the behavior pinned by the 0.45.1 tests', () => {
    expect(DEFAULT_CAPABILITIES).toEqual({
      version: undefined, source: 'default', supported: true, executableRefsOnly: false, primitiveMembers: false, linkQuoteEscapes: false, rawDoBodies: false,
    });
    expect(capabilitiesForVersion('0.45.1')).toMatchObject({ executableRefsOnly: false, primitiveMembers: false });
  });

  it('reads the installed version from the root or an ancestor, and nothing otherwise', () => {
    expect(readInstalledSpindleVersion(project('0.50.1'))).toBe('0.50.1');
    expect(readInstalledSpindleVersion(project('0.51.2', true))).toBe('0.51.2');
    const garbage = project('not-a-version');
    expect(readInstalledSpindleVersion(garbage)).toBeUndefined();
    const broken = project();
    mkdirSync(join(broken, 'node_modules', '@rohal12', 'spindle'), { recursive: true });
    writeFileSync(join(broken, 'node_modules', '@rohal12', 'spindle', 'package.json'), '{');
    expect(readInstalledSpindleVersion(broken)).toBeUndefined();
  });

  it('prefers the installed version, then StoryData format-version, then the default', () => {
    expect(resolveSpindleCapabilities('0.50.1', '0.43.0')).toMatchObject({ version: '0.50.1', source: 'installed' });
    expect(resolveSpindleCapabilities(undefined, '0.51.1')).toMatchObject({ version: '0.51.1', source: 'story-data' });
    expect(resolveSpindleCapabilities(undefined, 'x')).toBe(DEFAULT_CAPABILITIES);
    expect(resolveSpindleCapabilities(undefined)).toBe(DEFAULT_CAPABILITIES);
  });

  it('matches the runtime the tests import', () => {
    expect(INSTALLED_CAPABILITIES.version).toBe(INSTALLED_SPINDLE_VERSION);
    expect(INSTALLED_CAPABILITIES.source).toBe('installed');
  });
});

describe('WorkspaceModel target version', () => {
  const story = (storyData = '') => [
    storyData,
    ':: StoryVariables',
    '$name = "Bob"',
    '$gold = 10',
    ':: Start',
    'Hi $name.first and $ghost. {$name.length} {$gold.toFixed}',
    '',
  ].join('\n');

  it('uses the version installed under the workspace root', () => {
    expect(new WorkspaceModel({ workspaceRoot: project('0.50.1') }).capabilities.version).toBe('0.50.1');
    expect(new WorkspaceModel({ workspaceRoot: project('0.51.1', true) }).capabilities.version).toBe('0.51.1');
  });

  it('falls back to the default when nothing is installed or declared', () => {
    const { workspace } = diagnose(project(), story());
    expect(workspace.capabilities).toBe(DEFAULT_CAPABILITIES);
    expect(new WorkspaceModel().capabilities).toBe(DEFAULT_CAPABILITIES);
  });

  it('uses StoryData format-version when no Spindle is installed', () => {
    const data = ':: StoryData\n{"ifid": "A", "format": "Spindle", "format-version": "0.51.1"}\n';
    const { workspace } = diagnose(project(), story(data));
    expect(workspace.capabilities).toMatchObject({ version: '0.51.1', source: 'story-data', primitiveMembers: true });
  });

  it('ignores the format-version of another story format', () => {
    const data = ':: StoryData\n{"ifid": "A", "format": "SugarCube", "format-version": "2.37.3"}\n';
    const { workspace } = diagnose(project(), story(data));
    expect(workspace.capabilities).toBe(DEFAULT_CAPABILITIES);
  });

  it('prefers the installed version over StoryData', () => {
    const data = ':: StoryData\n{"ifid": "A", "format": "Spindle", "format-version": "0.51.1"}\n';
    const { workspace } = diagnose(project('0.45.1'), story(data));
    expect(workspace.capabilities).toMatchObject({ version: '0.45.1', source: 'installed' });
  });

  it('SP200/SP201 keep raw-text validation below 0.50.1', () => {
    for (const v of ['0.43.0', '0.45.1', '0.50.0']) {
      const { diagnostics } = diagnose(project(v), story());
      expect(diagnostics.filter(d => d.code === 'SP200').map(d => d.message)).toEqual([
        "Variable '$ghost' is not declared in StoryVariables",
      ]);
      // $name.first, $name.length (string) and $gold.toFixed (number)
      expect(diagnostics.filter(d => d.code === 'SP201').map(d => d.message.slice(0, 33))).toEqual([
        'Cannot access field "first" on $n',
        'Cannot access field "length" on $',
        'Cannot access field "toFixed" on ',
      ]);
    }
  });

  it('SP200/SP201 still read prose below 0.50.1 and ignore it from 0.50.1', () => {
    const prose = ':: StoryVariables\n$name = "Bob"\n:: Start\nHello $name.first, $ghost.\n"$name.last" // $name.x\n';
    const old = diagnose(project('0.50.0'), prose).diagnostics;
    expect(old.filter(d => d.code === 'SP200')).toHaveLength(1);
    expect(old.filter(d => d.code === 'SP201')).toHaveLength(3);
    const current = diagnose(project('0.50.1'), prose).diagnostics;
    expect(current.filter(d => d.code === 'SP200')).toHaveLength(0);
    expect(current.filter(d => d.code === 'SP201')).toHaveLength(0);
  });

  it('from 0.50.1 SP200/SP201 report executable references only', () => {
    const exec = [
      ':: StoryVariables', '$name = "Bob"', '$gold = 10',
      ':: Start',
      '{$name.first} {set $ghost = 1} {if $gold.coins}{/if} <b title="{$name.nope}">x</b>',
      '{do}$name.in_do = 1{/do} {print "{$name.in_str}"} {textbox "$unbound"}',
    ].join('\n');
    const { diagnostics } = diagnose(project('0.50.1'), exec);
    expect(diagnostics.filter(d => d.code === 'SP200').map(d => d.message)).toEqual([
      "Variable '$ghost' is not declared in StoryVariables",
      "Variable '$unbound' is not declared in StoryVariables",
    ]);
    expect(diagnostics.filter(d => d.code === 'SP201').map(d => d.message.split(' (')[0])).toEqual([
      'Cannot access field "first" on $name',
      'Cannot access field "coins" on $gold',
      'Cannot access field "nope" on $name',
      'Cannot access field "in_do" on $name',
      'Cannot access field "in_str" on $name',
    ]);
    // Ranges point at the field name in the source
    const first = diagnostics.find(d => d.code === 'SP201')!;
    expect(first.range.start.line).toBe(4);
    expect(exec.split('\n')[4].slice(first.range.start.character, first.range.end.character)).toBe('first');
  });

  it('allows primitive wrapper members from 0.51.1 only', () => {
    const text = ':: StoryVariables\n$s = "abc"\n$n = 1\n:: Start\n{$s.length} {$n.toFixed} {$s.length.x} {$s.nope} {$n.toFixed.y}\n';
    const fields = (v: string) => diagnose(project(v), text).diagnostics
      .filter(d => d.code === 'SP201').map(d => /field "(\w+)" on (\$[\w.]+)/.exec(d.message)!.slice(1).join(' on '));
    expect(fields('0.50.1')).toEqual(['length on $s', 'toFixed on $n', 'length on $s', 'nope on $s', 'toFixed on $n']);
    expect(fields('0.51.0')).toEqual(fields('0.50.1'));
    // 0.51.1: length is a number, so a field of it is rejected; toFixed is a function, so the walk stops
    expect(fields('0.51.1')).toEqual(['x on $s.length', 'nope on $s']);
    expect(fields('0.51.3')).toEqual(fields('0.51.1'));
  });
});

describe('SP001: Spindle older than the supported floor', () => {
  const text = ':: StoryVariables\n$x = 1\n:: StoryTransients\n%t = 1\n:: Start\n{%t} {$x}\n';

  it('warns once on the first story document for Spindle below 0.43.0', () => {
    const root = project('0.42.0');
    const workspace = new WorkspaceModel({ workspaceRoot: root });
    workspace.initialize(new Map([['file:///a.tw', text], ['file:///b.tw', ':: Other\nx\n']]));
    const a = computeDiagnostics('file:///a.tw', workspace).filter(d => d.code === 'SP001');
    const b = computeDiagnostics('file:///b.tw', workspace).filter(d => d.code === 'SP001');
    expect(b).toEqual([]);
    expect(a.map(d => d.severity)).toEqual(['warning', 'error']);
    expect(a[0].message).toContain('Spindle 0.42.0 is older than 0.43.0');
    expect(a[0].message).toContain('transients');
    expect(a[0].range.start.line).toBe(0);
    // the transient passage itself is flagged: the old runtime throws on it
    expect(a[1].message).toContain('does not support StoryTransients');
    expect(a[1].range.start.line).toBe(2);
  });

  it('is silent from 0.43.0 and when the version is unknown', () => {
    for (const root of [project('0.43.0'), project('0.51.3'), project(), undefined]) {
      expect(diagnose(root, text).diagnostics.filter(d => d.code === 'SP001')).toEqual([]);
    }
  });

  it('is silent for a project that is not a Spindle story', () => {
    const data = ':: StoryData\n{"ifid": "A", "format": "SugarCube", "format-version": "2.37.3"}\n';
    expect(diagnose(project('0.30.0'), data + text).diagnostics).toEqual([]);
  });

  it('follows a StoryData format-version below the floor', () => {
    const data = ':: StoryData\n{"ifid": "A", "format": "Spindle", "format-version": "0.38.0"}\n';
    const found = diagnose(project(), data + text).diagnostics.filter(d => d.code === 'SP001');
    expect(found.map(d => d.severity)).toEqual(['warning', 'error']);
  });
});
