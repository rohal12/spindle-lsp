import { afterEach, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { compile, decompileHTML, parseTwee } from '@rohal12/twee-ts';
import { openPlaySession, type PlaySession } from '@rohal12/spindle/play';
import { builtinMacros, validateStoryMarkup } from '@rohal12/spindle/tooling';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { parsePassageHeader } from '../../src/core/parsing/passage-parser.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeRename } from '../../src/plugins/rename.js';
import { computeCodeActions } from '../../src/plugins/code-actions.js';
import { getCompletions } from '../../src/plugins/completions.js';
import { getHoverInfo } from '../../src/plugins/hover.js';

const uri = 'file:///story.tw';
const metadata = ':: StoryTitle\nExample\n:: StoryData\n{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"}\n';
const models: WorkspaceModel[] = [];
function workspace(text: string, files: Array<[string, string]> = []) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text], ...files]));
  return model;
}
afterEach(() => models.splice(0).forEach(model => model.dispose()));

async function compiled(text: string) {
  return compile({
    sources: [{ filename: uri, content: text }],
    formatId: 'pkg',
    formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
    noRemote: true,
    useTweegoPath: false,
  });
}
async function play(text: string, check: (session: PlaySession) => Promise<void>) {
  const result = await compiled(text);
  const session = await openPlaySession({ html: result.output, trusted: true });
  try { await check(session); }
  finally { await session.close(); }
}
function renamed(text: string, model: WorkspaceModel, needle: string, name: string) {
  const doc = TextDocument.create(uri, 'twee3', 1, text);
  const edits = computeRename(uri, doc.positionAt(text.indexOf(needle) + 1), name, model).get(uri)!;
  expect(edits.length).toBeGreaterThan(0);
  return TextDocument.applyEdits(doc, edits);
}

it.each(['script', 'init'])('omits private %s macro definitions and preserves receiver renames (#163)', async origin => {
  const definition = 'Story.defineMacro({name:"textbox",parameters:[{name:"label",type:"string"}],render(){return null;}});';
  const privateSource = origin === 'script'
    ? `:: Macros [Twine.private script]\n${definition}`
    : `:: StoryInit [Twine.private]\n{do}${definition}{/do}`;
  const text = `${metadata}:: StoryVariables\n$x = "old"\n${privateSource}\n:: Start\n{textbox "$x"}`;
  const model = workspace(text);
  expect(model.macros.getMacro('textbox')?.source).toBe('builtin');
  expect(model.variables.getUsages('x')).toHaveLength(1);
  expect(computeDiagnostics(uri, model)).toEqual([]);
  const changed = renamed(text, model, '$x =', 'y');
  expect(changed).toContain('{textbox "$y"}');
  for (const source of [text, changed]) await play(source, async session => {
    expect(await session.observe()).toMatchObject({ errors: [] });
    expect(Object.values(await session.get())).toEqual(['old']);
  });
});

it.each(['Twine.private script', 'Twine.private', 'stylesheet'])('does not discover absent executable definitions tagged %s (#163)', tags => {
  const model = workspace(`${metadata}:: StoryVariables\n:: Start\n{custom}\n:: StoryInit [${tags}]\n`
    + '{do}Story.defineMacro({name:"custom",render(){return null;}});{/do}');
  expect(model.macros.getMacro('custom')).toBeUndefined();
  expect(computeDiagnostics(uri, model).map(d => d.code)).toEqual(['SP100']);
});

it('refreshes macro discovery when a source becomes private in another document (#163)', () => {
  const sourceUri = 'file:///macros.tw';
  const source = ':: Macros [script]\nStory.defineMacro({name:"custom",render(){return null;}});';
  const model = workspace(':: StoryVariables\n:: Start\n{custom}', [[sourceUri, source]]);
  expect(computeDiagnostics(uri, model)).toEqual([]);
  model.documents.update(sourceUri, source.replace('[script]', '[Twine.private script]'));
  expect(model.macros.getMacro('custom')).toBeUndefined();
  expect(computeDiagnostics(uri, model).map(d => d.code)).toEqual(['SP100']);
  model.documents.update(sourceUri, source);
  expect(computeDiagnostics(uri, model)).toEqual([]);
});

it.each(['Twine.private', 'script', 'stylesheet'])('ignores omitted declarations tagged %s, including cross-document updates (#164)', async tag => {
  const text = `${metadata}:: Start\n{$x} {%t}`;
  const declarationsUri = 'file:///variables.tw';
  const source = ':: StoryVariables\n$x = 1\n:: StoryTransients\n%t = {field: 1}';
  const model = workspace(text, [[declarationsUri, source]]);
  expect(model.variables.hasStoryVariables()).toBe(true);
  expect(model.variables.hasStoryTransients()).toBe(true);
  const omitted = source.replace('StoryVariables', `StoryVariables [${tag}]`).replace('StoryTransients', `StoryTransients [${tag}]`);
  model.documents.update(declarationsUri, omitted);
  expect(model.variables.hasStoryVariables()).toBe(false);
  expect(model.variables.hasStoryTransients()).toBe(false);
  expect(model.variables.getDeclared().size).toBe(0);
  expect(model.variables.getDeclaredTransient().size).toBe(0);
  expect(computeDiagnostics(declarationsUri, model).filter(d => d.code === 'SP207')).toEqual([]);
  expect(computeDiagnostics(uri, model).map(d => d.code)).toContain('SP202');
  expect(computeCodeActions(uri, computeDiagnostics(uri, model), model)).toEqual([]);
  if (tag === 'Twine.private') {
    const result = await compiled(`${text}\n${omitted}`);
    expect(decompileHTML(result.output).story.passages.map(p => p.name)).not.toContain('StoryVariables');
    await expect(openPlaySession({ html: result.output, trusted: true })).rejects.toThrow('Missing StoryVariables');
  }
  model.documents.update(declarationsUri, source);
  expect(model.variables.hasStoryVariables()).toBe(true);
  expect(model.variables.getDeclaredTransient().get('t')?.fields).toEqual(['field']);
  expect(computeDiagnostics(uri, model)).toEqual([]);
});

it.each(['\n', '\r\n'])('matches compiler names and applies complete passage renames with EOL %j (#165)', async eol => {
  for (const header of [':: Hall\\', '::Hall\\', ':: Hall\\\\', ':: Hall\\[A\\]', '\uFEFF:: Hall\\']) {
    const expected = parseTwee(header).passages[0].name;
    const found = parsePassageHeader(header, 0)!;
    expect(found.name).toBe(expected);
    expect(header.slice(found.nameRange.start.character, found.nameRange.end.character)).toContain('Hall');
  }
  const text = `${metadata}:: StoryVariables\n:: Start\n[[Hall]]\n:: Hall\\\nHello`.replaceAll('\n', eol);
  const model = workspace(text);
  expect(computeDiagnostics(uri, model)).toEqual([]);
  const changed = renamed(text, model, 'Hall\\', 'Lobby');
  expect(changed).toContain('[[Lobby]]');
  expect(changed).toContain(':: Lobby');
  await play(changed, async session => {
    const observation = await session.observe();
    expect(observation.errors).toEqual([]);
    expect(observation.actions).toHaveLength(1);
    expect(await session.step(observation.actions[0].id)).toMatchObject({ passage: 'Lobby', text: 'Hello', errors: [] });
  });
});

it('keeps bundled macro registration aligned with the runtime and permits real unless widgets (#166)', () => {
  const body = '{unless false}Hi{/unless}';
  const model = workspace(`:: StoryVariables\n:: Start\n${body}`);
  expect(model.macros.getMacro('unless')).toBeUndefined();
  const diagnostics = computeDiagnostics(uri, model);
  expect(diagnostics.map(d => d.message).sort()).toEqual(validateStoryMarkup([{ name: 'Start', content: body }], builtinMacros, { tolerant: true }).map(d => d.message).sort());
  expect(getCompletions(uri, { line: 2, character: 1 }, '{', model).map(c => c.label)).not.toContain('unless');
  model.documents.update(uri, ':: StoryVariables\n:: Start\n{unless}\n:: Widgets [widget]\n{widget unless}Hello{/widget}');
  expect(computeDiagnostics(uri, model)).toEqual([]);
  expect(model.widgets.getWidget('unless')).toBeDefined();
  model.macros.loadConfig({ unless: { container: true } });
  expect(model.macros.getMacro('unless')?.block).toBe(true);
});

it.each(['print', 'PRINT', 'custom'])('validates explicit schemas for a computed user macro named %s (#167)', name => {
  const model = workspace(`:: StoryVariables\n:: Start\n{${name} "one"}`, [['file:///macros.js',
    `Story.defineMacro({name:${JSON.stringify(name)},parameters:["first","second"].map(name=>({name,type:"string",required:true})),render(){return "ok";}});`]]);
  model.macros.loadConfig({ [name]: { parameters: ['string &+ string'] } });
  expect(computeDiagnostics(uri, model)).toEqual([expect.objectContaining({ code: 'SP109', message: expect.stringContaining("Expected type 'string' but no argument found") })]);
  model.documents.update(uri, `:: StoryVariables\n:: Start\n{${name} "one" "two"}`);
  expect(computeDiagnostics(uri, model)).toEqual([]);
});

it('leaves declared runtime parameters in charge of user macro validation (#167)', () => {
  const model = workspace(':: StoryVariables\n:: Start\n{print 42}', [['file:///macros.js',
    'Story.defineMacro({name:"print",parameters:[{name:"label",type:"string",required:true}],render(){return "ok";}});']]);
  model.macros.loadConfig({ print: { parameters: ['string'] } });
  expect(computeDiagnostics(uri, model).map(d => d.code)).toEqual(['SP109']);
});

it.each(['script', 'stylesheet', 'Twine.private'])('does not create a passage colliding with an omitted %s source in another file (#168)', async tag => {
  const text = `${metadata}:: StoryVariables\n:: Start\n[[Hidden]] [[Missing]]`;
  const model = workspace(text, [['file:///source.tw', `:: Hidden [${tag}]\n/* Preserve me */`]]);
  const diagnostics = computeDiagnostics(uri, model);
  const actions = computeCodeActions(uri, diagnostics, model);
  expect(actions.map(a => a.title)).not.toContain("Create passage 'Hidden'");
  const create = actions.find(a => a.title === "Create passage 'Missing'")!;
  expect(create).toBeDefined();
  const result = TextDocument.applyEdits(TextDocument.create(uri, 'twee3', 1, text), create.edits);
  expect(parseTwee(result).passages.filter(p => p.name === 'Missing')).toHaveLength(1);
  expect(model.documents.getText('file:///source.tw')).toContain('/* Preserve me */');
});

it.each(['', 'zoom:1', 'invalid', 'custom:value'])('derives StorySettings omission from compiler-decoded settings %j (#158 residual)', async settings => {
  const text = `${metadata}:: StoryVariables\n:: Start\n[[StorySettings]]\n:: StorySettings\n${settings}`;
  const model = workspace(text);
  const result = await compiled(text);
  const emitted = decompileHTML(result.output).story.passages.some(p => p.name === 'StorySettings');
  expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP300')).toHaveLength(emitted ? 0 : 1);
  expect(model.passages.getPassage('StorySettings')).toBeDefined();
  model.documents.update(uri, text.slice(0, text.lastIndexOf('\n') + 1) + (emitted ? '' : 'custom:value'));
  expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP300')).toHaveLength(emitted ? 1 : 0);
});

it.each(['button', 'meter', 'watch', 'unwatch'])('runs the actual advertised %s example (#155 residual)', async name => {
  const model = workspace(':: StoryVariables\n$x = 1\n:: Start\n{' + name + '}');
  const hover = getHoverInfo(uri, { line: 3, character: 2 }, model)!;
  const example = name === 'button' ? /```\n([\s\S]*?)\n```/.exec(hover.contents)![1] : /Usage: `([^`]+)`/.exec(hover.contents)![1];
  const watchExample = name === 'unwatch' ? model.macros.getMacro('watch')!.description!.match(/Usage: `([^`]+)`/)![1] : '';
  const text = `${metadata}:: StoryVariables\n$x = 1\n:: Start\n${watchExample}${example}\n:: Hall\nArrived`;
  await play(text, async session => {
    const observation = await session.observe();
    expect(observation.errors).toEqual([]);
    if (name === 'button') {
      expect(observation.actions[0].label).toBe('Go');
      expect(await session.step(observation.actions[0].id)).toMatchObject({ passage: 'Hall', errors: [] });
    } else if (name === 'watch' || name === 'unwatch') {
      await session.set({ x: 2 });
      expect(await session.get(['x'])).toEqual({ x: name === 'watch' ? 0 : 2 });
    } else expect(observation.text).toContain('50');
  });
});
