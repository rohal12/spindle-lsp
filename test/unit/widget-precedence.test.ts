import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from '@rohal12/twee-ts';
import { openPlaySession } from '@rohal12/spindle/play';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeRename, prepareRename } from '../../src/plugins/rename.js';
import { findReferences } from '../../src/plugins/references.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { getHoverInfo } from '../../src/plugins/hover.js';
import { getSignatureHelp } from '../../src/plugins/signature.js';
import { computeInlayHints } from '../../src/plugins/inlay-hints.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const models: WorkspaceModel[] = [];
const directories: string[] = [];
afterEach(() => {
  models.splice(0).forEach(model => model.dispose());
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});
function workspace(text: string, script?: string) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([['file:///story.tw', text], ...(script ? [['file:///macros.js', script] as [string, string]] : [])]));
  return model;
}

async function render(directory: string, content: string, script?: string) {
  if (script) writeFileSync(join(directory, 'macros.js'), script);
  writeFileSync(join(directory, 'story.tw'), content);
  const result = await compile({ sources: [directory], formatId: 'pkg',
    formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
    noRemote: true, useTweegoPath: false });
  expect(result.diagnostics.filter(d => d.level === 'error')).toEqual([]);
  const session = await openPlaySession({ html: result.output, trusted: true });
  try {
    const observed = await session.observe();
    expect(observed.errors).toEqual([]);
    return observed.text;
  } finally { await session.close(); }
}

it.each(['builtin', 'configured', 'discovered'] as const)('uses the effective widget before a %s macro across editor features (#181)', source => {
  const name = source === 'builtin' ? 'print' : 'caption';
  const text = `:: Widgets [widget]\n{widget "${name}" @value}CUSTOM:{@value}{/widget}\n:: StoryVariables\n:: Start\n{${name.toUpperCase()} "hello"}\n`;
  const model = workspace(text, source === 'discovered'
    ? 'Story.defineMacro({name:"caption",parameters:[{name:"destination",type:"passage",required:true}],render(){return null;}});' : undefined);
  if (source === 'configured') model.macros.loadConfig({ caption: { parameters: [] } });
  const uri = 'file:///story.tw';
  const call = { line: 4, character: 2 };
  const widget = model.widgets.getWidget(name)!;
  expect(getDefinition(uri, call, model)?.range).toEqual(widget.range);
  expect(findReferences(uri, call, model, true)).toHaveLength(2);
  expect(prepareRename(uri, call, model)?.placeholder).toBe(name.toUpperCase());
  expect(getHoverInfo(uri, call, model)?.contents).toContain('**Widget**');
  expect(getSignatureHelp(uri, { line: 4, character: name.length + 3 }, model)?.signatures[0].parameters.map(p => p.label)).toEqual(['@value']);
  expect(computeInlayHints(uri, { start: call, end: { line: 5, character: 0 } }, model).map(h => h.label)).toEqual(['@value:']);
  expect(computeDiagnostics(uri, model).filter(d => d.severity === 'error')).toEqual([]);
  model.documents.update(uri, text.replace('"hello"', '"hello" "extra"'));
  expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP301')).toHaveLength(1);
});

it.each(['print', 'if', 'include'].flatMap(name => ['declaration', 'call'].map(origin => [name, origin])))(
  'preserves runtime output when renaming a widget named %s from its %s (#181)', async (name, origin) => {
    const directory = mkdtempSync(join(tmpdir(), 'spindle-widget-precedence-'));
    directories.push(directory);
    const uri = pathToFileURL(join(directory, 'story.tw')).href;
    const text = `:: StoryTitle\nExample\n:: StoryData\n{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"}\n:: Widgets [widget]\n{widget "${name}" @value}CUSTOM:{@value}${name === 'if' ? '{@children}' : ''}{/widget}\n:: StoryVariables\n:: Start\n{${name} "hello"}${name === 'if' ? '{/if}' : ''}\n`;
    const model = new WorkspaceModel();
    models.push(model);
    model.initialize(new Map([[uri, text]]));
    expect(await render(directory, text)).toBe('CUSTOM:hello');
    const at = origin === 'declaration' ? { line: 5, character: 11 } : { line: 8, character: 2 };
    const edits = computeRename(uri, at, 'caption', model);
    const changed = TextDocument.applyEdits(TextDocument.create(uri, 'twee3', 1, text), edits.get(uri) ?? []);
    expect(changed).toContain('{widget "caption"');
    expect(changed).toContain('{caption "hello"}');
    expect(await render(directory, changed)).toBe('CUSTOM:hello');
});

it('retains macro-only behavior and rejects renaming a widget onto a macro name (#181)', () => {
  const model = workspace(':: Widgets [widget]\n{widget "caption" @value}{@value}{/widget}\n:: StoryVariables\n:: Start\n{print "hello"}\n{caption "hello"}');
  expect(getDefinition('file:///story.tw', { line: 4, character: 2 }, model)).toBeNull();
  expect(getHoverInfo('file:///story.tw', { line: 4, character: 2 }, model)?.contents).toContain('macro');
  expect(prepareRename('file:///story.tw', { line: 4, character: 2 }, model)).toBeNull();
  expect(() => computeRename('file:///story.tw', { line: 5, character: 2 }, 'print', model)).toThrow();
});

it('ignores an overridden macro schema when safely renaming a passage (#181)', () => {
  const text = ':: Widgets [widget]\n{widget "caption" @value}{@value}{/widget}\n:: StoryVariables\n:: Hall\nroom\n:: Start\n{caption "Hall"}[[Hall]]\n';
  const model = workspace(text);
  model.macros.loadConfig({ caption: { parameters: ['...passage'] } });
  const edits = computeRename('file:///story.tw', { line: 3, character: 4 }, 'Room', model);
  const changed = TextDocument.applyEdits(TextDocument.create('file:///story.tw', 'twee3', 1, text), edits.get('file:///story.tw') ?? []);
  expect(changed).toContain(':: Room');
  expect(changed).toContain('{caption "Hall"}[[Room]]');
});

it.each(['builtin', 'discovered'])('rejects a rename that would lose a same-name %s macro body contract (#181)', async source => {
  const directory = mkdtempSync(join(tmpdir(), 'spindle-widget-precedence-'));
  directories.push(directory);
  const name = source === 'builtin' ? 'if' : 'caption';
  const script = source === 'discovered' ? 'Story.defineMacro({name:"caption",block:true,render(){return null;}});' : undefined;
  const text = `:: StoryTitle\nExample\n:: StoryData\n{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"}\n:: Widgets [widget]\n{widget "${name}" @value}CUSTOM:{@value}{/widget}\n:: StoryVariables\n:: Start\n{${name} "hello"}ignored{/${name}}\n`;
  const model = workspace(text, script);
  expect(await render(directory, text, script)).toBe('CUSTOM:hello');
  expect(computeDiagnostics('file:///story.tw', model).filter(d => d.severity === 'error')).toEqual([]);
  expect(findReferences('file:///story.tw', { line: 8, character: 2 }, model, true)).toHaveLength(3);
  for (const at of [{ line: 5, character: 11 }, { line: 8, character: 2 }, { line: 8, character: name.length + 20 }]) {
    expect(() => computeRename('file:///story.tw', at, 'renamed', model)).toThrow(/container body/);
    expect(model.documents.getText('file:///story.tw')).toBe(text);
  }
});
