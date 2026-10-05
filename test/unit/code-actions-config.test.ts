import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeCodeActions } from '../../src/plugins/code-actions.js';
import type { CodeAction } from '../../src/plugins/code-actions.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { parseConfig } from '../../src/core/workspace/config-loader.js';
import type { Position } from '../../src/core/types.js';

/** Apply a code action's edits for `uri` to `text`, as an editor would. */
function applyEdits(text: string, action: CodeAction, uri: string): string {
  const offset = (p: Position) => {
    const lines = text.split('\n');
    let o = 0;
    for (let i = 0; i < p.line; i++) o += lines[i].length + 1;
    return o + p.character;
  };
  const edits = action.edits
    .filter(e => e.uri === uri)
    .map(e => ({ start: offset(e.range.start), end: offset(e.range.end), newText: e.newText }))
    .sort((a, b) => b.start - a.start);
  let result = text;
  for (const e of edits) result = result.slice(0, e.start) + e.newText + result.slice(e.end);
  return result;
}

describe('SP100 quick fix targets the project config', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spindle-codeaction-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function sp100Action(
    macroName = 'nosuch',
    opts: { root?: string; docPath?: string; ws?: WorkspaceModel } = {},
  ): CodeAction | undefined {
    const docPath = opts.docPath ?? join(dir, 'story.tw');
    const docUri = pathToFileURL(docPath).toString();
    const ws = opts.ws ?? new WorkspaceModel();
    ws.initialize(new Map([[docUri, `:: Start\n{${macroName}}\n`]]));
    const diags = computeDiagnostics(docUri, ws).filter(d => d.code === 'SP100');
    expect(diags).toHaveLength(1);
    const actions = computeCodeActions(docUri, diags, ws, { workspaceRoot: 'root' in opts ? opts.root : dir });
    ws.dispose();
    return actions[0];
  }

  /** Write `content` to `name`, run the fix, apply it, and return the new text. */
  function fixConfig(name: string, content: string, macroName = 'nosuch'): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    const action = sp100Action(macroName);
    expect(action).toBeDefined();
    expect(action!.createFile).toBeUndefined();
    expect(action!.title).toBe(`Add '${macroName}' to ${name}`);
    const uri = pathToFileURL(path).toString();
    expect(action!.edits.every(e => e.uri === uri)).toBe(true);
    return applyEdits(content, action!, uri);
  }

  const macrosOf = (text: string, format: 'yaml' | 'json') => parseConfig(text, format).macros;

  it('creates spindle.config.yaml in the workspace root when no config exists', () => {
    const action = sp100Action();
    const uri = pathToFileURL(join(dir, 'spindle.config.yaml')).toString();
    expect(action).toMatchObject({ title: "Add 'nosuch' to spindle.config.yaml", createFile: uri });
    expect(action!.edits).toHaveLength(1);
    expect(action!.edits[0].range).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
    const created = applyEdits('', action!, uri);
    expect(macrosOf(created, 'yaml')).toEqual({ nosuch: { description: '' } });
  });

  it('accepts the workspace root as a file URI', () => {
    const action = sp100Action('nosuch', { root: pathToFileURL(dir).toString() });
    expect(action!.createFile).toBe(pathToFileURL(join(dir, 'spindle.config.yaml')).toString());
  });

  it('appends to an existing macros mapping without touching other lines', () => {
    const original = [
      '# Project macros',
      'macros:',
      '  # first macro',
      '  foo:',
      '    description: "Foo"  # keep me',
      '    parameters: ["text"]',
      '',
      '  bar:',
      '    container: true',
      'enums:',
      '  mood: "happy|sad"',
      '',
    ].join('\n');
    const result = fixConfig('spindle.config.yaml', original);
    expect(macrosOf(result, 'yaml')).toEqual({
      foo: { description: 'Foo', parameters: ['text'] },
      bar: { container: true },
      nosuch: { description: '' },
    });
    expect(parseConfig(result, 'yaml').enums).toEqual({ mood: 'happy|sad' });
    // Original lines are preserved verbatim
    expect(result.split('\n').filter(l => !original.split('\n').includes(l)))
      .toEqual(['  nosuch:', '    description: ""']);
  });

  it('matches the existing indentation', () => {
    const result = fixConfig('spindle.config.yml', 'macros:\n    foo:\n        description: x\n');
    expect(result).toBe('macros:\n    foo:\n        description: x\n    nosuch:\n        description: ""\n');
  });

  it('handles a config without a trailing newline or with trailing comments', () => {
    expect(macrosOf(fixConfig('spindle.config.yaml', 'macros:\n  foo: {}'), 'yaml'))
      .toEqual({ foo: {}, nosuch: { description: '' } });
    expect(macrosOf(fixConfig('spindle.config.yaml', 'macros:\n  foo: {}\n  # end of macros\n\nenums: {}\n'), 'yaml'))
      .toEqual({ foo: {}, nosuch: { description: '' } });
  });

  it.each([
    ['no macros key', 'enums:\n  a: b\n'],
    ['an empty macros key', 'macros:\n'],
    ['a flow-style macros mapping', 'macros: {}\n'],
    ['an empty file', ''],
    ['only comments', '# nothing yet\n'],
  ])('produces valid YAML for %s', (_label, content) => {
    const result = fixConfig('spindle.config.yaml', content);
    expect(macrosOf(result, 'yaml')).toMatchObject({ nosuch: { description: '' } });
  });

  it('adds to a JSON config preserving its indentation', () => {
    const original = '{\n    "macros": {\n        "foo": { "parameters": [] }\n    }\n}\n';
    const result = fixConfig('spindle.config.json', original);
    expect(JSON.parse(result)).toEqual({ macros: { foo: { parameters: [] }, nosuch: { description: '' } } });
    expect(result).toContain('\n        "nosuch": {\n            "description": ""\n        }\n');
    expect(result.endsWith('}\n')).toBe(true);
  });

  it('adds a macros object to a JSON config without one', () => {
    const result = fixConfig('spindle.config.json', '{"enums": {}}');
    expect(JSON.parse(result)).toEqual({ enums: {}, macros: { nosuch: { description: '' } } });
  });

  it('writes into the spindle-0 section of legacy t3lt configs', () => {
    const yaml = fixConfig('t3lt.twee-config.yaml', 'spindle-0:\n  macros:\n    foo:\n      container: true\n');
    expect(macrosOf(yaml, 'yaml')).toEqual({ foo: { container: true }, nosuch: { description: '' } });

    rmSync(join(dir, 't3lt.twee-config.yaml'));
    const json = fixConfig('t3lt.twee-config.json', '{"spindle-0": {"enums": {}}}');
    expect(macrosOf(json, 'json')).toEqual({ nosuch: { description: '' } });
  });

  it('uses the config file the loader would pick', () => {
    writeFileSync(join(dir, 't3lt.twee-config.yaml'), 'macros: {}\n');
    writeFileSync(join(dir, 'spindle.config.json'), '{"macros": {}}\n');
    expect(sp100Action()!.title).toBe("Add 'nosuch' to spindle.config.json");
  });

  it('uses the unsaved editor contents of an open config', () => {
    const path = join(dir, 'spindle.config.yaml');
    const uri = pathToFileURL(path).toString();
    writeFileSync(path, 'macros:\n  ondisk: {}\n');
    const ws = new WorkspaceModel();
    ws.documents.open(uri, 'macros:\n  ondisk: {}\n  unsaved: {}\n');
    const action = sp100Action('nosuch', { ws });
    const result = applyEdits('macros:\n  ondisk: {}\n  unsaved: {}\n', action!, uri);
    expect(Object.keys(macrosOf(result, 'yaml'))).toEqual(['ondisk', 'unsaved', 'nosuch']);
    // the file on disk is never touched by computing the action
    expect(readFileSync(path, 'utf-8')).toBe('macros:\n  ondisk: {}\n');
  });

  it('finds the nearest config above the document when no workspace root is known', () => {
    writeFileSync(join(dir, 'spindle.config.yaml'), 'macros:\n  foo: {}\n');
    mkdirSync(join(dir, 'src', 'chapters'), { recursive: true });
    const action = sp100Action('nosuch', { root: undefined, docPath: join(dir, 'src', 'chapters', 'one.tw') });
    expect(action!.edits[0].uri).toBe(pathToFileURL(join(dir, 'spindle.config.yaml')).toString());
  });

  it('offers no edit for an invalid config or an already configured macro', () => {
    writeFileSync(join(dir, 'spindle.config.yaml'), 'macros: [unclosed\n');
    expect(sp100Action()).toBeUndefined();
    writeFileSync(join(dir, 'spindle.config.yaml'), 'macros:\n  NoSuch: {}\n');
    expect(sp100Action()).toBeUndefined();
  });
});
