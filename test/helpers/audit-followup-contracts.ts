/** Extensions of HEADER, W74, STRUCTURE, CONFIGURED-ARGS and PRETTIER-CONFIG. */
import { afterEach, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseTwee } from '@rohal12/twee-ts';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeRename, prepareRename } from '../../src/plugins/rename.js';
import { findReferences, findWidgetReferences, findPassageReferences } from '../../src/plugins/references.js';
import { computeCodeLenses } from '../../src/plugins/code-lens.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { getSignatureHelp } from '../../src/plugins/signature.js';
import { formatDocument } from '../../src/plugins/format.js';
import { parsePassageHeader } from '../../src/core/parsing/passage-parser.js';

type Register = (name: string, run: () => void | Promise<void>) => void;
const uri = 'file:///followup.tw';
const defs = 'file:///definitions.tw';
const scriptUri = 'file:///macros.js';
const doc = (text: string, path = uri) => TextDocument.create(path, 'twee', 1, text);
const models: WorkspaceModel[] = [];
const directories: string[] = [];
function model(files: Map<string, string>) {
  const workspace = new WorkspaceModel();
  models.push(workspace);
  workspace.initialize(files);
  return workspace;
}
function apply(files: Map<string, string>, edits: Map<string, any[]>) {
  return new Map([...files].map(([path, text]) => [path, TextDocument.applyEdits(doc(text, path), edits.get(path) ?? [])]));
}
const greeting = 'Story.defineMacro({name:"greet", description:"A greeting", parameters:[{name:"who",type:"string",required:true,description:"Recipient"},{name:"count",type:"number"}],render(){return null;}});';
export function registerAuditFollowupContracts(test: Register): void {
  afterEach(() => {
    for (const workspace of models.splice(0)) workspace.dispose();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  for (const eol of ['\n', '\r\n']) {
    for (const spelling of ['"greeting-one"', "'greeting-one'", 'greeting-one']) {
      for (const separate of [false, true]) for (const include of [false, true]) {
        test(`W74/references-from-definition/${spelling}/${separate}/${include}/${eol.length}`, () => {
          const definition = `:: W [widget]\n{widget ${spelling} @children}{@children}{/widget}\n`.replaceAll('\n', eol);
          const calls = ':: StoryVariables\n:: Start\n{.red GREETING-one}text{/GREETING-one}\n<span title="{greeting-one}text{/greeting-one}">x</span>\n<!-- {greeting-one} -->\n{print "{greeting-one}"}\n'.replaceAll('\n', eol);
          const files = new Map(separate ? [[defs, definition], [uri, calls]] : [[uri, definition + calls]]);
          const workspace = model(files);
          const widget = workspace.widgets.getWidget('greeting-one')!;
          const fromDefinition = findReferences(widget.uri, widget.nameRange.start, workspace, include);
          const refs = findWidgetReferences(widget.name, workspace, false);
          expect(refs).toHaveLength(4);
          expect(fromDefinition).toEqual(findReferences(refs[0].uri, refs[0].range.start, workspace, include));
          expect(fromDefinition).toHaveLength(4 + Number(include));
          expect(prepareRename(widget.uri, widget.nameRange.start, workspace)?.range).toEqual(widget.nameRange);
          const renamed = apply(files, computeRename(widget.uri, widget.nameRange.start, 'fresh', workspace));
          const rebuilt = model(renamed);
          expect(findWidgetReferences('fresh', rebuilt, false)).toHaveLength(4);
          expect(renamed.get(uri)).toContain('<!-- {greeting-one} -->');
          expect(renamed.get(uri)).toContain('{print "{greeting-one}"}');
          expect(computeDiagnostics(uri, rebuilt).filter(d => d.severity === 'error')).toEqual([]);
        });
      }
    }
    for (const name of ['button', 'print', 'if', 'custom']) for (const block of [false, true]) {
      test(`W74/widget-precedence/${name}/${block}/${eol.length}`, () => {
        const definition = `:: W [widget]\n{widget "${name}"}${block ? '{@children}' : 'body'}{/widget}\n`.replaceAll('\n', eol);
        const container = block || name === 'button' || name === 'if';
        const call = `{${name.toUpperCase()}}${container ? `body{/${name.toUpperCase()}}` : ''}`;
        const story = `:: StoryVariables\n:: Start\n${call}\n`.replaceAll('\n', eol);
        const files = new Map([[defs, definition], [uri, story]]);
        if (name === 'custom') files.set(scriptUri, 'Story.defineMacro({name:"custom",render(){return null;}});');
        const workspace = model(files);
        const widget = workspace.widgets.getWidget(name)!;
        expect(findReferences(defs, widget.nameRange.start, workspace, false)).toHaveLength(container ? 2 : 1);
        expect(findReferences(defs, widget.nameRange.start, workspace, true)).toHaveLength(container ? 3 : 2);
        expect(computeCodeLenses(defs, workspace).find(l => l.range.start.line === 1)?.command.title).toBe('1 usage');
        if (container && !block) {
          expect(() => computeRename(defs, widget.nameRange.start, 'newWidget', workspace)).toThrow(/container body/);
          return;
        }
        const output = apply(files, computeRename(defs, widget.nameRange.start, 'newWidget', workspace));
        expect(output.get(uri)).toBe(story.replaceAll(name.toUpperCase(), 'newWidget'));
        expect(output.get(defs)).toBe(definition.replace(`"${name}"`, '"newWidget"'));
        expect(computeDiagnostics(uri, model(output)).filter(d => d.severity === 'error')).toEqual([]);
      });
    }
    for (const encoded of ['X', '\\ X', 'X\\ ', '\\ X\\ ', 'X\\  [tag]', 'X\\  {"position":"1,2"}', 'A\\[B', 'A\\{B', 'A\\\\B']) {
      test(`HEADER/escaped-identity/${JSON.stringify(encoded)}/${eol.length}`, async () => {
        const expected = encoded.startsWith('A') ? encoded.replace(/\\(.)/g, '$1') : 'X';
        const header = `:: ${encoded}`;
        const parsed = parsePassageHeader(header, 0)!;
        expect(parsed.name).toBe(expected);
        const sourceName = header.slice(parsed.nameRange.start.character, parsed.nameRange.end.character);
        expect(sourceName).toBe(encoded.split(' [tag]')[0].split(' {"position"')[0]);
        const text = `${header}\nbody\n:: StoryVariables\n:: Start\n{goto ${JSON.stringify(expected)}}\n`.replaceAll('\n', eol);
        const compiled = parseTwee(text);
        expect(compiled.diagnostics).toEqual([]);
        expect(compiled.passages[0].name).toBe(expected);
        const files = new Map([[uri, text]]);
        const workspace = model(files);
        const refs = findPassageReferences(expected, workspace, false);
        expect(refs).toHaveLength(1);
        expect(getDefinition(uri, refs[0].range.start, workspace)?.range).toEqual(workspace.passages.getPassage(expected)!.headerEnd);
        expect(computeDiagnostics(uri, workspace).filter(d => d.code === 'SP300')).toEqual([]);
        const formatted = await formatDocument(text);
        expect(parseTwee(formatted).passages.map(p => p.name)).toEqual(compiled.passages.map(p => p.name));
        expect(parsePassageHeader(formatted.split(eol)[0], 0)?.name).toBe(expected);
        expect(await formatDocument(formatted)).toBe(formatted);
        const renamed = apply(files, computeRename(uri, parsed.nameRange.start, 'Fresh', workspace));
        expect(findPassageReferences('Fresh', model(renamed), false)).toHaveLength(1);
        expect(parsePassageHeader(renamed.get(uri)!.split(eol)[0], 0)?.name).toBe('Fresh');
        expect(parseTwee(renamed.get(uri)!).passages[0].name).toBe('Fresh');
      });
    }
    test(`HEADER/escaped-special-role/${eol.length}`, async () => {
      const text = ':: \\ StoryVariables\n$x = "a long declaration payload with spaces"\n:: Start\n{$x}\n'.replaceAll('\n', eol);
      const workspace = model(new Map([[uri, text]]));
      expect(workspace.variables.getDeclared().has('x')).toBe(true);
      expect(prepareRename(uri, { line: 0, character: 5 }, workspace)).toBeNull();
      expect(await formatDocument(text, { maxLineLength: 20 })).toContain('$x = "a long declaration payload with spaces"');
    });
    for (const origin of ['js', 'script', 'StoryInit']) {
      test(`CONFIGURED-ARGS/runtime-parameterDefs/${origin}/${eol.length}`, () => {
        const declaration = origin === 'script' ? `:: Macros [script]\n${greeting}\n` : origin === 'StoryInit' ? `:: StoryInit\n{do}${greeting}{/do}\n` : '';
        const text = `${declaration}:: StoryVariables\n:: Start\n{greet "Alice" }\n`.replaceAll('\n', eol);
        const files = new Map([[uri, text]]);
        if (origin === 'js') files.set(scriptUri, greeting);
        const workspace = model(files);
        const at = doc(text).positionAt(text.lastIndexOf(' }') + 1);
        const help = getSignatureHelp(uri, at, workspace)!;
        expect(help?.activeParameter).toBe(1);
        expect(help.signatures[0]).toMatchObject({ label: '{greet who [count]}', documentation: 'A greeting' });
        expect(help.signatures[0].parameters[0].documentation).toBe('Recipient\n\nType: string');
        expect(help.signatures[0].parameters[1].documentation).toBe('Type: number');
        expect(getSignatureHelp(uri, doc(text).positionAt(text.lastIndexOf('"Alice"') + 3), workspace)?.activeParameter).toBe(0);
        workspace.macros.loadConfig({ greet: { parameters: ['number &+ number'], parameterDocs: [{ name: 'override' }, { name: 'other' }] } });
        expect(getSignatureHelp(uri, at, workspace)?.signatures[0].label).toContain('override');
        workspace.macros.loadConfig({});
        expect(getSignatureHelp(uri, at, workspace)?.signatures[0].label).toBe('{greet who [count]}');
        const owner = origin === 'js' ? scriptUri : uri;
        workspace.documents.update(owner, files.get(owner)!.replace('name:"count"', 'name:"times"'));
        expect(getSignatureHelp(uri, at, workspace)?.signatures[0].label).toBe('{greet who [times]}');
        workspace.documents.update(owner, origin === 'js' ? '' : text.replace(greeting, ''));
        expect(getSignatureHelp(uri, at, workspace)).toBeNull();
      });
    }
    const wrappers: Record<string, (s: string) => string> = {
      top: s => s,
      button: s => `{button ${JSON.stringify(s)}}clicked{/button}`,
      link: s => `{link ${JSON.stringify(s)} "Start"}clicked{/link}`,
      attribute: s => `<span title='${s}'>x</span>`,
      nested: s => `{button ${JSON.stringify(`{button ${JSON.stringify(s)}}x{/button}`)}}y{/button}`,
      'separate-parent': s => `{listbox $choice}{option 'real'}<span title='${s}'>x</span>{/listbox}`,
    };
    const fragments: Array<[string, string, string | null]> = [
      ['duplicate-default', '{switch 2}{case 1}x{default}y{default}z{/switch}', 'SP114'],
      ['orphan-option', '{option "hi"}', 'SP107'],
      ['valid-switch', '{switch 2}{case 1}x{default}y{/switch}', null],
      ['configured-parent', '{child}', 'SP107'],
      ['configured-valid', '{parent}{child}{/parent}', null],
    ];
    for (const [wrapper, wrap] of Object.entries(wrappers)) for (const [name, fragment, code] of fragments) {
      if (wrapper === 'separate-parent' && name !== 'orphan-option') continue;
      test(`STRUCTURE/${wrapper}/${name}/${eol.length}`, () => {
        const text = `:: StoryVariables\n$choice = ""\n:: Start\n${wrap(fragment)}\n`.replaceAll('\n', eol);
        const workspace = model(new Map([[uri, text]]));
        workspace.macros.loadConfig({ parent: { container: true, children: [{ name: 'child', min: 1, max: 1 }] }, child: { parents: ['parent'] } });
        const diagnostics = computeDiagnostics(uri, workspace).filter(d => ['SP107', 'SP114', 'SP115'].includes(d.code));
        expect(diagnostics.map(d => d.code)).toEqual(code ? [code] : []);
        for (const diagnostic of diagnostics) expect(doc(text).getText(diagnostic.range)).toContain(name.includes('option') ? 'option' : name.includes('default') ? 'switch' : 'child');
      });
    }
  }
  for (const config of ['json', 'yaml', 'package']) for (const location of ['root', 'nested']) {
    test(`PRETTIER-CONFIG/state-add-edit-delete/${config}/${location}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'spindle-followup-prettier-'));
      directories.push(directory);
      mkdirSync(join(directory, 'nested'));
      writeFileSync(join(directory, 'package.json'), '{}');
      const configRoot = location === 'nested' ? join(directory, 'nested') : directory;
      const configFile = join(configRoot, config === 'package' ? 'package.json' : `.prettierrc.${config}`);
      const path = join(directory, 'nested/story.tw');
      const text = ':: Code [script]\nif(true){console.log("hello");}\n:: Style [stylesheet]\n.x{color:red}\n:: Start\n<script>\nconsole.log("hello");\n</script>\n';
      const format = () => formatDocument(text, { filePath: pathToFileURL(path).toString() });
      expect(await format()).toContain('  console.log("hello");');
      const setConfig = (singleQuote: boolean, width: number) => writeFileSync(configFile, config === 'yaml' ? `singleQuote: ${singleQuote}\ntabWidth: ${width}\n` : JSON.stringify(config === 'package' ? { prettier: { singleQuote, tabWidth: width } } : { singleQuote, tabWidth: width }));
      setConfig(true, 6);
      const added = await format();
      expect(added).toContain("      console.log('hello');");
      expect(added).toContain('.x {\n      color: red;');
      expect(added.split("'hello'")).toHaveLength(3);
      expect(await format()).toBe(added);
      setConfig(false, 4);
      expect(await format()).toContain('    console.log("hello");');
      rmSync(configFile);
      expect(await format()).toContain('  console.log("hello");');
    });
  }
  test('PRETTIER-CONFIG/nested-override-edit-delete-fallback', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'spindle-followup-prettier-'));
    directories.push(directory);
    mkdirSync(join(directory, 'nested'));
    writeFileSync(join(directory, 'package.json'), '{}');
    writeFileSync(join(directory, '.prettierrc.json'), '{"singleQuote":true,"tabWidth":6}');
    const nested = join(directory, 'nested/.prettierrc.json');
    const filePath = join(directory, 'nested/story.tw');
    const text = ':: Code [script]\nif(true){console.log("hello");}\n';
    const format = () => formatDocument(text, { filePath });
    expect(await format()).toContain("      console.log('hello');");
    writeFileSync(nested, '{"singleQuote":false,"tabWidth":4}');
    expect(await format()).toContain('    console.log("hello");');
    writeFileSync(nested, '{"singleQuote":true,"tabWidth":8}');
    expect(await format()).toContain("        console.log('hello');");
    rmSync(nested);
    expect(await format()).toContain("      console.log('hello');");
  });
}
