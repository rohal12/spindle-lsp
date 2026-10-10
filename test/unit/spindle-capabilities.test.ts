/**
 * The Spindle a project targets. spindle-lsp follows one release range
 * (`>= MINIMUM_SPINDLE_VERSION`, through `@rohal12/spindle/tooling`): there is
 * no per-release behavior, and the version is only read to say so when the
 * project's Spindle is older. These tests pin how the version is found
 * (installed copy, then StoryData) and the warning (SP001).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TARGET,
  MINIMUM_SPINDLE_VERSION,
  parseSpindleVersion,
  readInstalledSpindleVersion,
  resolveSpindleTarget,
  unsupportedVersionMessage,
} from '../../src/core/workspace/spindle-version.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { INSTALLED_SPINDLE_VERSION } from '../helpers/spindle-version.js';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** A project directory with `version` of Spindle "installed" (or none). */
function project(version?: string, nested = false): string {
  const root = mkdtempSync(join(tmpdir(), 'spindle-target-'));
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

describe('Spindle target', () => {
  it('compares numerically and ignores a prerelease suffix', () => {
    expect(parseSpindleVersion('0.100.2')).toEqual([0, 100, 2]);
    expect(parseSpindleVersion('v0.59.20')).toEqual([0, 59, 20]);
    expect(parseSpindleVersion('latest')).toBeUndefined();
    expect(resolveSpindleTarget('0.9.0').supported).toBe(false);
    expect(resolveSpindleTarget('0.59.19').supported).toBe(false);
    expect(resolveSpindleTarget('0.59.20').supported).toBe(true);
    expect(resolveSpindleTarget('0.100.0').supported).toBe(true);
    expect(resolveSpindleTarget('1.0.0').supported).toBe(true);
    expect(resolveSpindleTarget('0.59.21-beta.2')).toMatchObject({ version: '0.59.21', supported: true });
    expect(resolveSpindleTarget('latest')).toBe(DEFAULT_TARGET);
  });

  it('has no version by default, and nothing to warn about', () => {
    expect(DEFAULT_TARGET).toEqual({ version: undefined, source: 'default', supported: true });
  });

  it('reads the installed version from the root or an ancestor, and nothing otherwise', () => {
    expect(readInstalledSpindleVersion(project('0.59.20'))).toBe('0.59.20');
    expect(readInstalledSpindleVersion(project('0.59.22', true))).toBe('0.59.22');
    const garbage = project('not-a-version');
    expect(readInstalledSpindleVersion(garbage)).toBeUndefined();
    const broken = project();
    mkdirSync(join(broken, 'node_modules', '@rohal12', 'spindle'), { recursive: true });
    writeFileSync(join(broken, 'node_modules', '@rohal12', 'spindle', 'package.json'), '{');
    expect(readInstalledSpindleVersion(broken)).toBeUndefined();
  });

  it('prefers the installed version, then StoryData format-version, then the default', () => {
    expect(resolveSpindleTarget('0.59.23', '0.43.0')).toMatchObject({ version: '0.59.23', source: 'installed', supported: true });
    expect(resolveSpindleTarget(undefined, '0.59.21')).toMatchObject({ version: '0.59.21', source: 'story-data', supported: true });
    expect(resolveSpindleTarget(undefined, '0.43.0')).toMatchObject({ version: '0.43.0', source: 'story-data', supported: false });
    expect(resolveSpindleTarget(undefined, 'x')).toBe(DEFAULT_TARGET);
    expect(resolveSpindleTarget(undefined)).toBe(DEFAULT_TARGET);
  });

  it('matches the runtime the tests import', () => {
    expect(resolveSpindleTarget(INSTALLED_SPINDLE_VERSION)).toMatchObject({ version: INSTALLED_SPINDLE_VERSION, supported: true });
  });

  it('names the minimum in the warning', () => {
    const message = unsupportedVersionMessage(resolveSpindleTarget('0.50.0'));
    expect(message).toContain(`Spindle 0.50.0 is older than ${MINIMUM_SPINDLE_VERSION}`);
    expect(message).toContain(`Update @rohal12/spindle to ${MINIMUM_SPINDLE_VERSION} or later`);
  });
});

describe('SP001: Spindle older than the supported minimum', () => {
  const text = ':: StoryVariables\n$x = 1\n:: Start\n{$x}\n';

  it('warns once on the first story document', () => {
    const root = project('0.59.19');
    const workspace = new WorkspaceModel({ workspaceRoot: root });
    workspace.initialize(new Map([['file:///a.tw', text], ['file:///b.tw', ':: Other\nx\n']]));
    const a = computeDiagnostics('file:///a.tw', workspace).filter(d => d.code === 'SP001');
    const b = computeDiagnostics('file:///b.tw', workspace).filter(d => d.code === 'SP001');
    expect(b).toEqual([]);
    expect(a).toHaveLength(1);
    expect(a[0].severity).toBe('warning');
    expect(a[0].message).toBe(unsupportedVersionMessage(resolveSpindleTarget('0.59.19')));
    expect(a[0].range.start.line).toBe(0);
  });

  it('is silent from the minimum and when the version is unknown', () => {
    for (const root of [project(MINIMUM_SPINDLE_VERSION), project('0.59.23'), project(INSTALLED_SPINDLE_VERSION), project(), undefined]) {
      expect(diagnose(root, text).diagnostics.filter(d => d.code === 'SP001')).toEqual([]);
    }
  });

  it('is silent for a project that is not a Spindle story', () => {
    const data = ':: StoryData\n{"ifid": "A", "format": "SugarCube", "format-version": "2.37.3"}\n';
    expect(diagnose(project('0.30.0'), data + text).diagnostics).toEqual([]);
  });

  it('follows a StoryData format-version below the minimum', () => {
    const data = ':: StoryData\n{"ifid": "A", "format": "Spindle", "format-version": "0.38.0"}\n';
    const found = diagnose(project(), data + text).diagnostics.filter(d => d.code === 'SP001');
    expect(found.map(d => d.severity)).toContain('warning');
  });

  it('prefers the installed Spindle over the StoryData format-version', () => {
    const data = ':: StoryData\n{"ifid": "A", "format": "Spindle", "format-version": "0.38.0"}\n';
    // The installed copy is the runtime the story builds with: it wins over StoryData
    expect(diagnose(project('0.59.23'), data + text).diagnostics.filter(d => d.code === 'SP001')).toEqual([]);
  });
});
