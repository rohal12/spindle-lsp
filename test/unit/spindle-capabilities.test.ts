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

/** The package.json of a project that depends on Spindle. */
const DECLARES_SPINDLE = { name: 'story', dependencies: { '@rohal12/spindle': '*' } };

/**
 * A project directory with `version` of Spindle "installed" (or none). Its
 * package.json is `manifest` (none when null); by default it declares
 * Spindle, so the installed copy is the project's own.
 */
function project(
  version?: string,
  nested = false,
  manifest: object | null = DECLARES_SPINDLE,
): string {
  const root = mkdtempSync(join(tmpdir(), 'spindle-target-'));
  roots.push(root);
  if (manifest !== null) writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
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
    expect(resolveSpindleTarget('0.59.31').supported).toBe(false);
    expect(resolveSpindleTarget('0.60.0').supported).toBe(true);
    expect(resolveSpindleTarget('0.100.0').supported).toBe(true);
    expect(resolveSpindleTarget('1.0.0').supported).toBe(true);
    expect(resolveSpindleTarget('0.60.1-beta.2')).toMatchObject({ version: '0.60.1', supported: true });
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

  it('counts an installed copy only when the project declares @rohal12/spindle', () => {
    // A copy hoisted by another package (spindle-lsp's own dependency) is not the project's
    const lspOnly = { name: 'story', dependencies: { '@rohal12/spindle-lsp': '*' } };
    expect(readInstalledSpindleVersion(project('0.70.0', false, lspOnly))).toBeUndefined();
    expect(readInstalledSpindleVersion(project('0.70.0', true, { name: 'story' }))).toBeUndefined();
    expect(readInstalledSpindleVersion(project('0.70.0', false, null))).toBeUndefined();
    const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    for (const field of fields) {
      const manifest = { name: 'story', [field]: { '@rohal12/spindle': '^0.70.0' } };
      expect(readInstalledSpindleVersion(project('0.70.0', true, manifest)), field).toBe('0.70.0');
    }
  });

  it('accepts a declaration between the story and the node_modules, as in a workspace', () => {
    // Root package.json declares nothing; the workspace package that holds the story does,
    // and npm hoisted its Spindle to the root node_modules.
    const root = project('0.70.0', false, { name: 'monorepo', workspaces: ['story'] });
    const story = join(root, 'story');
    mkdirSync(join(story, 'src'), { recursive: true });
    writeFileSync(join(story, 'package.json'), JSON.stringify(DECLARES_SPINDLE));
    expect(readInstalledSpindleVersion(join(story, 'src'))).toBe('0.70.0');
    // A declaration above the node_modules does not adopt it
    const outer = project(undefined, false, DECLARES_SPINDLE);
    const inner = join(outer, 'inner');
    mkdirSync(join(inner, 'node_modules', '@rohal12', 'spindle'), { recursive: true });
    writeFileSync(join(inner, 'package.json'), JSON.stringify({ name: 'inner' }));
    writeFileSync(
      join(inner, 'node_modules', '@rohal12', 'spindle', 'package.json'),
      JSON.stringify({ name: '@rohal12/spindle', version: '0.70.0' }),
    );
    expect(readInstalledSpindleVersion(inner)).toBeUndefined();
  });

  it('prefers the installed version, then StoryData format-version, then the default', () => {
    expect(resolveSpindleTarget('0.60.3', '0.43.0')).toMatchObject({ version: '0.60.3', source: 'installed', supported: true });
    expect(resolveSpindleTarget(undefined, '0.60.1')).toMatchObject({ version: '0.60.1', source: 'story-data', supported: true });
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
    for (const root of [project(MINIMUM_SPINDLE_VERSION), project('0.60.3'), project(INSTALLED_SPINDLE_VERSION), project(), undefined]) {
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

  it('follows StoryData when the installed Spindle is not the project\'s own', () => {
    // `npm i @rohal12/spindle-lsp` hoists spindle-lsp's Spindle into a project that has none
    const data = ':: StoryData\n{"ifid": "A", "format": "Spindle", "format-version": "0.50.0"}\n';
    const manifest = { name: 'story', devDependencies: { '@rohal12/spindle-lsp': '*' } };
    const root = project('0.70.0', false, manifest);
    const { workspace, diagnostics } = diagnose(root, data + text);
    expect(workspace.target).toMatchObject({
      version: '0.50.0',
      source: 'story-data',
      supported: false,
    });
    expect(diagnostics.filter(d => d.code === 'SP001').map(d => d.severity)).toEqual(['warning']);
  });

  it('prefers the installed Spindle over the StoryData format-version', () => {
    const data = ':: StoryData\n{"ifid": "A", "format": "Spindle", "format-version": "0.38.0"}\n';
    // The installed copy is the runtime the story builds with: it wins over StoryData
    expect(diagnose(project('0.60.3'), data + text).diagnostics.filter(d => d.code === 'SP001')).toEqual([]);
  });

  it('ends at the first header, not past its line, on CRLF and mixed line endings', () => {
    const root = project('0.59.19');
    for (const [eol, source] of [
      ['crlf', text.replaceAll('\n', '\r\n')],
      ['mixed', ':: StoryVariables\r\n$x = 1\n:: Start\r\n{$x}\n'],
    ]) {
      const found = diagnose(root, source).diagnostics.filter(d => d.code === 'SP001');
      expect(found.map(d => d.range), eol).toEqual([{ start: { line: 0, character: 0 }, end: { line: 0, character: 17 } }]);
    }
  });
});
