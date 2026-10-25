import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { compile, parseTwee, StoryBuilder } from '@rohal12/twee-ts';
import { builtinMacros, completionContext, parseBoundVariable, validateStoryMarkup } from '@rohal12/spindle/tooling';
import { openPlaySession } from '@rohal12/spindle/play';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { parsePassageHeader } from '../../src/core/parsing/passage-parser.js';
import { buildLineStarts, offsetToPosition, splitLines } from '../../src/core/text.js';
import { storyFormatOfTexts } from '../../src/core/workspace/story-format.js';
import { computeRename, prepareRename } from '../../src/plugins/rename.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { computeDocumentLinks } from '../../src/plugins/document-link.js';
import { findReferences } from '../../src/plugins/references.js';
import { getCompletions } from '../../src/plugins/completions.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeCodeActions } from '../../src/plugins/code-actions.js';
import { formatDocument, formatPlugin } from '../../src/plugins/format.js';
import { checkFiles, formatFiles } from '../../src/mcp/server.js';

const uri = 'file:///story.tw';
const metadata = ':: StoryTitle\nAudit\n:: StoryData\n{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"}\n';
const models: WorkspaceModel[] = [];
const directories: string[] = [];
afterEach(() => {
  models.splice(0).forEach(model => model.dispose());
  directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
function workspace(text: string, files: Array<[string, string]> = []) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text], ...files]));
  return model;
}
function document(text: string) { return TextDocument.create(uri, 'twee', 1, text); }
function rename(text: string, model: WorkspaceModel, at: number, name = 'y') {
  return TextDocument.applyEdits(document(text), computeRename(uri, document(text).positionAt(at), name, model).get(uri) ?? []);
}
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-issue-contracts-'));
  directories.push(dir);
  return dir;
}
async function observe(text: string) {
  const dir = directory();
  writeFileSync(join(dir, 'story.tw'), text);
  const result = await compile({ sources: [dir], formatId: 'pkg',
    formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
    noRemote: true, useTweegoPath: false });
  expect(result.diagnostics.filter(d => d.level === 'error')).toEqual([]);
  const session = await openPlaySession({ html: result.output, trusted: true });
  try {
    const result = await session.observe();
    expect(result.errors).toEqual([]);
    return result;
  } finally { await session.close(); }
}

it.each([false, true])('selects effective StoryData across files=%s, unsaved changes and removal (#189)', separate => {
  const first = ':: StoryData\n{"format":"Spindle","format-version":"0.1.0"}\n';
  const second = ':: StoryData\n{"format":"SugarCube","format-version":"9.0.0"}\n';
  const later = 'file:///z.tw';
  const model = workspace(separate ? first : first + second, separate ? [[later, second]] : []);
  const builder = new StoryBuilder();
  for (const passage of parseTwee(first + second).passages) builder.add(passage, []);
  expect(builder.build().twine2.format).toBe('SugarCube');
  expect(model.storyFormat).toBe('SugarCube');
  expect(model.isSpindleProject()).toBe(false);
  expect(storyFormatOfTexts([first, second]).isSpindle).toBe(false);
  const target = separate ? later : uri;
  model.documents.update(target, (separate ? '' : first) + ':: StoryData\n{"format":"Spindle","format-version":"0.62.7"}\n');
  expect(model.target).toMatchObject({ version: '0.62.7', supported: true });
  model.documents.update(target, (separate ? '' : first) + ':: StoryData\n{}\n');
  expect(model.storyFormat).toBeUndefined();
  expect(model.target.version).toBeUndefined();
  model.documents.update(target, separate ? '' : first);
  expect(model.storyFormat).toBe('Spindle');
  expect(model.target).toMatchObject({ version: '0.1.0', supported: false });
});

it('protects literal foreign-format content from MCP formatting (#189)', async () => {
  const dir = directory();
  const text = ':: StoryData\n{"format":"Spindle"}\n:: StoryData\n{"format":"SugarCube"}\n:: Start\n<<print `a\n   b`>>\n';
  writeFileSync(join(dir, 'story.tw'), text);
  expect(await formatFiles('story.tw', dir)).toMatchObject({ formatted: 0, skipped: expect.stringContaining('SugarCube') });
  expect(readFileSync(join(dir, 'story.tw'), 'utf8')).toBe(text);
});

it.each([false, true])('navigates to effective duplicate passages across files=%s and tracks replacements (#190)', separate => {
  const first = ':: Hall\nOLD\n';
  const second = ':: Hall\nNEW\n';
  const later = 'file:///z.tw';
  const text = ':: StoryVariables\n' + first + (separate ? '' : second) + ':: Start\n[[Hall]]\n';
  const model = workspace(text, separate ? [[later, second]] : []);
  const at = () => { const current = model.documents.getText(uri)!; return document(current).positionAt(current.lastIndexOf('Hall')); };
  const assertTarget = () => {
    const effective = model.passages.getEffectivePassage('Hall')!;
    expect(getDefinition(uri, at(), model)).toEqual({ uri: effective.uri, range: effective.headerEnd });
    expect(computeDocumentLinks(uri, model)[0].target).toBe(`${effective.uri}#L${effective.range.start.line + 1}`);
  };
  const builder = new StoryBuilder();
  for (const passage of parseTwee(first + second).passages) builder.add(passage, []);
  expect(builder.build().passages.find(p => p.name === 'Hall')?.text).toBe('NEW');
  expect(model.passages.getEffectivePassage('Hall')?.range.start.line).toBe(separate ? 0 : 3);
  assertTarget();
  model.documents.update(separate ? later : uri, separate ? ':: Other\n' : text.replace(second, ''));
  assertTarget();
  expect(model.passages.getEffectivePassage('Hall')?.range.start.line).toBe(1);
});

it.each(['\n', '\r\n', '\r'])('keeps concatenated BOM header names and live references for %j (#191)', async eol => {
  const text = (metadata + ':: StoryVariables\n$x = "old"\n\uFEFF:: Start\n{$x}\n[[Start]]\n').replaceAll('\n', eol);
  const model = workspace(text);
  const header = model.passages.getEffectivePassage('Start')!;
  expect(header.nameRange.start.character).toBe(4);
  expect(header.nameRange.end.character).toBe(9);
  expect(document(text).getText(header.nameRange)).toBe('Start');
  expect(model.variables.getUsages('x')).toHaveLength(1);
  expect(computeDocumentLinks(uri, model)[0].target).toBe(`${uri}#L7`);
  const output = rename(text, model, text.indexOf('$x'));
  expect(output).toContain('{$y}');
  expect((await observe(text)).text).toContain('old');
  expect((await observe(output)).text).toContain('old');
});

it.each(['\uFEFF', '\u0085', ' ', '\t'])('assigns compiler passage roles for tag separator %j (#192)', async separator => {
  const header = `:: Start [script${separator}extra]`;
  const expected = parseTwee(header + '\n{$x}').passages[0];
  const parsed = parsePassageHeader(header, 4)!;
  expect(parsed.tags).toEqual(expected.tags);
  const text = metadata + `:: StoryVariables\n$x = "old"\n${header}\n` + (expected.tags.includes('script') ? 'console.log("control");\n' : '{$x}\n');
  const model = workspace(text);
  expect(model.variables.getUsages('x')).toHaveLength(expected.tags.includes('script') ? 0 : 1);
  expect(parseTwee(await formatDocument(text)).passages.at(-1)?.tags).toEqual(expected.tags);
  if (!expected.tags.includes('script')) {
    expect((await observe(rename(text, model, text.indexOf('$x')))).text).toBe('old');
  }
  const spaced = '::\u0085A\u0085[widget]';
  const name = parsePassageHeader(spaced, 3)!;
  expect(name.name).toBe(parseTwee(spaced).passages[0].name);
  expect(spaced.slice(name.nameRange.start.character, name.nameRange.end.character)).toBe('A');
});

it.each(['\r', '\r\n', '\n', 'mixed'])('maps line endings %j through diagnostics, rename, quick fixes and formatting (#193)', async eol => {
  const lines = [':: StoryVariables', '$x = "old"', ':: Start', '{if true}', '{$x}', '{/if}', '[[Start]]', ''];
  const text = eol === 'mixed' ? lines.map((line, i) => line + (i === lines.length - 1 ? '' : ['\r', '\r\n', '\n'][i % 3])).join('') : lines.join(eol);
  const model = workspace(text);
  const client = document(text);
  const starts = buildLineStarts(text);
  for (const offset of starts) expect(offsetToPosition(offset, starts)).toEqual(client.positionAt(offset));
  expect(splitLines(text)).toEqual(lines);
  const renamed = rename(text, model, text.indexOf('$x'));
  expect(renamed).toContain('{$y}');
  const formatted = await formatDocument(renamed);
  expect(await formatDocument(formatted)).toBe(formatted);
  expect((await observe(metadata + formatted)).text).toContain('old');
  if (eol === '\r') expect(formatted).not.toContain('\n');
  const broken = text.replace('{/if}', '');
  model.documents.update(uri, broken);
  const compilerPassages = parseTwee(broken).passages.map(p => ({ name: p.name, tags: p.tags, content: p.text }));
  expect(validateStoryMarkup(compilerPassages, builtinMacros, { tolerant: true }).length).toBeGreaterThan(0);
  expect(computeDiagnostics(uri, model)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SP101', range: expect.objectContaining({ start: { line: 3, character: 0 } }) })]));
  const dir = directory();
  writeFileSync(join(dir, 'story.tw'), broken);
  expect(await checkFiles('story.tw', undefined, dir)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SP101' })]));
  model.documents.update(uri, text.replace('{$x}', '{$missing}'));
  const problem = computeDiagnostics(uri, model).find(d => d.code === 'SP200')!;
  const action = computeCodeActions(uri, [problem], model).find(a => a.title.includes('Declare'))!;
  const fixed = TextDocument.applyEdits(document(model.documents.getText(uri)!), action.edits.filter(e => e.uri === uri));
  expect(parseTwee(fixed).passages.find(p => p.name === 'StoryVariables')?.text).toContain('$missing = 0');
});

it.each(['x', '"x"', '"$x"', String.raw`"$\u0078"`, String.raw`"$\u{78}"`])('preserves runtime input binding %s during rename (#186)', async binding => {
  const text = metadata + `:: StoryVariables\n$x = "old"\n:: Start\n{textbox ${binding}}\n`;
  const model = workspace(text);
  const usage = model.variables.getUsages('x')[0];
  expect(usage).toBeDefined();
  expect(prepareRename(uri, usage.range.start, model)?.placeholder).toBe('x');
  expect(findReferences(uri, usage.range.start, model, true)).toHaveLength(2);
  const changed = rename(text, model, text.indexOf('$x'));
  expect(rename(text, model, document(text).offsetAt(usage.range.start))).toBe(changed);
  expect(parseBoundVariable(splitLines(changed).at(-2)!.slice('{textbox '.length, -1))?.name).toBe('y');
  expect((await observe(text)).actions).toEqual(expect.arrayContaining([expect.objectContaining({ variable: 'x', value: 'old' })]));
  expect((await observe(changed)).actions).toEqual(expect.arrayContaining([expect.objectContaining({ variable: 'y', value: 'old' })]));
});

it('preserves escaped binding members while replacing only the root (#186)', async () => {
  const text = metadata + String.raw`:: StoryVariables
$x = {"field":"old"}
:: Start
{textbox "$\u0078.\u0066ield"}
`;
  const model = workspace(text);
  const changed = rename(text, model, text.indexOf('$x'));
  expect(changed).toContain(String.raw`{textbox "$y.\u0066ield"}`);
  expect(model.variables.getUsages('x')).toHaveLength(1);
  expect(workspace(changed).variables.getUsages('y')).toHaveLength(1);
  expect((await observe(changed)).actions).toEqual(expect.arrayContaining([expect.objectContaining({ variable: 'y.field', value: 'old' })]));
});

it('accepts escaped configured receiver bindings using the runtime reader (#187)', () => {
  const text = metadata + ':: StoryVariables\n$x = "old"\n:: Macros [script]\nStory.defineMacro({name:"field",storeVar:true,render(props,ctx){return String(ctx.value);}});\n:: Start\n{field "$\\u0078"}\n';
  const model = new WorkspaceModel();
  models.push(model);
  model.macros.loadConfig({ field: { parameters: ['receiver'] } });
  model.initialize(new Map([[uri, text]]));
  expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP109')).toEqual([]);
});

it.each(['caption', 'print', 'do'])('renames live %s widgets inside a do-widget markup body (#179)', async name => {
  const text = metadata + `:: StoryVariables\n:: Widgets [widget]\n{widget "do" @children}{@children}{/widget}\n${name === 'do' ? '' : `{widget "${name}" @value}CUSTOM:{@value}{/widget}\n`}:: Start\n{do}${name === 'do' ? 'hello' : `{${name} "hello"}`}{/do}\n`;
  const model = workspace(text);
  const widget = model.widgets.getWidget(name)!;
  const changed = rename(text, model, document(text).offsetAt(widget.nameRange.start), 'fresh');
  expect(changed).toContain(name === 'do' ? '{fresh}hello{/fresh}' : '{do}{fresh "hello"}{/do}');
  expect((await observe(changed)).text).toBe((await observe(text)).text);
});

it.each(['"', "'"])('encodes bracket-field completions inside unfinished %s labels (#183)', async quote => {
  const prefix = metadata + ':: StoryVariables\n$obj = {"first-name":"Ada"}\n:: Start\n';
  const label = `{button ${quote}{print $obj.`;
  const text = prefix + label;
  const model = workspace(text);
  expect(completionContext(label, label.length, builtinMacros)).toMatchObject({ kind: 'code', containers: [{ kind: 'string', quote }] });
  const item = getCompletions(uri, document(text).positionAt(text.length), '.', model).find(c => c.label === 'first-name')!;
  const changed = TextDocument.applyEdits(document(text), [item.textEdit as { range: import('../../src/core/types.js').Range; newText: string }]) + `}${quote}}x{/button}\n`;
  expect(computeDiagnostics(uri, workspace(changed)).filter(d => d.severity === 'error')).toEqual([]);
  expect((await observe(changed)).actions).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Ada' })]));
});

it('keeps StoryData replacement order past ten documents (#189)', () => {
  const texts = Array.from({ length: 12 }, (_, i) => `:: StoryData\n${JSON.stringify({ format: i === 11 ? 'SugarCube' : 'Spindle' })}\n`);
  expect(storyFormatOfTexts(texts)).toMatchObject({ name: 'SugarCube', isSpindle: false });
});

it('applies full-document LSP formatting edits to CR-only source (#193)', async () => {
  const text = ':: StoryVariables\r:: Start\r{if true}\rhello\r{/if}\r';
  const model = workspace(text);
  let handler: (params: any) => Promise<any[]>;
  formatPlugin.initialize({ workspace: model, connection: {
    onDocumentFormatting(callback: typeof handler) { handler = callback; },
    onDocumentRangeFormatting() {},
  } } as any);
  const edits = await handler!({ textDocument: { uri } });
  expect(edits[0].range.end).toEqual(document(text).positionAt(text.length));
  const changed = TextDocument.applyEdits(document(text), edits);
  expect(changed).toBe(await formatDocument(text));
  expect(changed).toContain('\r  hello\r');
});

it('encodes completion text through multiple unfinished label containers (#183)', () => {
  const whole = `{button ${JSON.stringify(`{button ${JSON.stringify('{print $obj.}')}}x{/button}`)}}x{/button}`;
  const offset = whole.indexOf('$obj.') + '$obj.'.length;
  const prefix = ':: StoryVariables\n$obj = {"first-name":"Ada"}\n:: Start\n';
  const text = prefix + whole.slice(0, offset);
  const model = workspace(text);
  const item = getCompletions(uri, document(text).positionAt(text.length), '.', model).find(c => c.label === 'first-name')!;
  const changed = TextDocument.applyEdits(document(text), [item.textEdit as any]) + whole.slice(offset);
  expect(computeDiagnostics(uri, workspace(changed)).filter(d => d.severity === 'error')).toEqual([]);
});
