/** Ticket-owned behavior tables shared by unit tests and retained named cells. */
import { afterEach, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { builtinMacros, discoverMacros, passagePieces, parseStoryVariables, passageTarget, splitArgs, tokenizeMarkupTolerant, variableReferences, widgetDefinitions } from '@rohal12/spindle/tooling';
import { WorkspaceModel } from '../../../src/core/workspace/workspace-model.js';
import { computeRename, prepareRename } from '../../../src/plugins/rename.js';
import { getDefinition } from '../../../src/plugins/definition.js';
import { computeInlayHints } from '../../../src/plugins/inlay-hints.js';
import { parsePassageHeader } from '../../../src/core/parsing/passage-parser.js';
import { classifyPassage, splitPassages } from '../../../src/plugins/format/segment.js';
import { computeDiagnostics } from '../../../src/plugins/diagnostics.js';
import { computeCodeActions } from '../../../src/plugins/code-actions.js';
import { computeDocumentSymbols } from '../../../src/plugins/document-symbol.js';
import { getCompletions } from '../../../src/plugins/completions.js';
import { getSignatureHelp } from '../../../src/plugins/signature.js';
import { formatDocument } from '../../../src/plugins/format.js';
import { parseConfig } from '../../../src/core/workspace/config-loader.js';
import { lexArguments } from '../../../src/core/parsing/argument-lexer.js';
import { evaluate } from '../../helpers/expression-oracle.js';
import { findVariableReferences, findTransientReferences, findPassageReferences } from '../../../src/plugins/references.js';
import { searchWorkspaceSymbols } from '../../../src/plugins/workspace-symbol.js';
import type { Dims } from './harness.js';

type Cell = (id: string, dims: Dims, run: () => void | Promise<void>) => void;
const uri = 'file:///story.tw';
const models: WorkspaceModel[] = [];
const directories: string[] = [];
function workspace(text: string, extra: Record<string, string> = {}): WorkspaceModel {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text], ...Object.entries(extra)]));
  return model;
}
function doc(text: string) { return TextDocument.create(uri, 'twee', 0, text); }
function applied(text: string, edits: Parameters<typeof TextDocument.applyEdits>[1]) { return TextDocument.applyEdits(doc(text), edits); }

export function registerRepairContracts(cell: Cell): void {
  afterEach(() => {
    for (const model of models.splice(0)) model.dispose();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  const row = (family: string, spelling: string, consumer: string, run: () => void | Promise<void>, boundary = 'LF') =>
    cell(`N/${family}/${spelling}`, { role: 'ordinary/declarations', context: family, spelling, boundary, state: 'multi-file/rebuilt', consumer }, run);

  // #105: actual file paths select root, nested and per-file Prettier options.
  for (const config of ['json', 'yaml', 'package', 'none']) {
    for (const location of ['root', 'nested', 'override']) {
      row('PRETTIER-CONFIG', `${config}-${location}`, 'script/style/embedded formatting with document path outside cwd', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'spindle-prettier-'));
        directories.push(directory);
        const options = { singleQuote: true, tabWidth: 6 };
        const root = location === 'override' ? { ...options, overrides: [{ files: 'special.tw', options: { tabWidth: 4 } }] } : options;
        writeFileSync(join(directory, 'package.json'), JSON.stringify(config === 'package' ? { prettier: root } : {}));
        if (config === 'json') writeFileSync(join(directory, '.prettierrc.json'), JSON.stringify(root));
        if (config === 'yaml') writeFileSync(join(directory, '.prettierrc.yaml'), 'singleQuote: true\ntabWidth: 6\n' + (location === 'override' ? 'overrides:\n  - files: special.tw\n    options:\n      tabWidth: 4\n' : ''));
        mkdirSync(join(directory, 'nested'));
        if (location === 'nested' && config !== 'none') writeFileSync(join(directory, 'nested/.prettierrc.json'), JSON.stringify({ singleQuote: true, tabWidth: 8 }));
        const filePath = join(directory, location === 'nested' ? 'nested/story.tw' : location === 'override' ? 'special.tw' : 'story.tw');
        const width = config === 'none' ? 2 : location === 'nested' ? 8 : location === 'override' ? 4 : 6;
        const text = ':: Code [script]\nif(true){console.log("hello");}\n:: Style [stylesheet]\n.a{color:red}\n:: Start\n<script>\nconsole.log("hello");\n</script>\n';
        const output = await formatDocument(text, { filePath: pathToFileURL(filePath).toString() });
        expect(output).toContain(`${' '.repeat(width)}console.log(${config === 'none' ? '"hello"' : "'hello'"});`);
        expect(output).toContain(`.a {\n${' '.repeat(width)}color: red;\n}`);
        expect(output.split(config === 'none' ? '"hello"' : "'hello'")).toHaveLength(3);
        expect(await formatDocument(output, { filePath })).toBe(output);
      });
    }
  }

  // #13/#83: use the runtime's identifier spans and declaration validation.
  for (const sigil of ['$', '%'] as const) {
    for (const destination of ['__proto__', `${sigil}__proto__`, 'constructor', 'prototype', 'toString', 'fresh', '5']) {
      row('RENAME-COLLISION', `runtime-name-${sigil}-${destination}`, 'atomic rejection or applied/rebuilt runtime-valid declaration', () => {
        const text = `:: StoryVariables\n${sigil === '$' ? '$x = 1\n' : ':: StoryTransients\n%x = 1\n'}:: Start\n{${sigil}x}\n`;
        const model = workspace(text);
        const at = doc(text).positionAt(text.indexOf(`${sigil}x`) + 1);
        const rename = () => computeRename(uri, at, destination, model);
        if (destination.includes('__proto__') || (sigil === '%' && destination === '5')) expect(rename).toThrow();
        else {
          const output = applied(text, rename().get(uri)!);
          expect(parseStoryVariables(`${sigil}${destination} = 1`, sigil).has(destination)).toBe(true);
          expect(computeDiagnostics(uri, workspace(output)).filter(d => d.severity === 'error')).toEqual([]);
        }
      });
    }
  }

  // #93: destinations must not merge bindings. #83's grammar stays a control.
  for (const sigil of ['$', '%'] as const) {
    for (const where of ['declaration', 'usage']) {
      for (const destination of ['same-scope', 'cross-scope', 'unused', 'noop', 'invalid-internal-dollar', 'digit-leading']) {
        row('RENAME-COLLISION', `${sigil}-${where}-${destination}`, 'rename applied/rebuilt and binding preservation', () => {
          const source = `:: StoryVariables\n$a = 1\n${sigil === '$' ? '$b = 2\n' : ''}:: StoryTransients\n%a = 1\n${sigil === '%' ? '%b = 2\n' : ''}:: Start\n{${sigil}a} {${sigil}a.value}\n`;
          // Use distinct names in the two namespaces for the cross-scope check.
          const text = source.replace(sigil === '$' ? '%a = 1' : '$a = 1', sigil === '$' ? '%other = 1' : '$other = 1');
          const model = workspace(text);
          const at = text.indexOf(`${sigil}a`, where === 'usage' ? text.indexOf(':: Start') : 0) + 1;
          const name = { 'same-scope': 'b', 'cross-scope': 'other', unused: 'fresh', noop: 'a', 'invalid-internal-dollar': 'a$b', 'digit-leading': '5' }[destination]!;
          const rename = () => computeRename(uri, doc(text).positionAt(at), name, model);
          if (['same-scope', 'cross-scope', 'invalid-internal-dollar'].includes(destination) || (sigil === '%' && destination === 'digit-leading')) {
            expect(rename).toThrow();
            expect(model.documents.getText(uri)).toBe(text);
          } else if (destination === 'noop') expect(rename().size).toBe(0);
          else {
            const output = applied(text, rename().get(uri)!);
            expect(output).toContain(`${sigil}${name} = 1`);
            expect(output).toContain(`{${sigil}${name}.value}`);
            const rebuilt = workspace(output);
            const declared = sigil === '$' ? rebuilt.variables.getDeclared() : rebuilt.variables.getDeclaredTransient();
            expect(declared.has(name)).toBe(true);
            expect(declared.has('a')).toBe(false);
            expect(parseStoryVariables(`${sigil}${name} = 1`, sigil).has(name)).toBe(true);
          }
        });
      }
    }
  }
  for (const destination of ['two', 'TWO', 'one', 'ONE', 'fresh', 'if']) {
    row('RENAME-COLLISION', `widget-${destination}`, 'widget rename/definition/usages', () => {
      const text = ':: StoryVariables\n:: W [widget]\n{widget "one"}one{/widget}\n:: Start\n{one} {two}\n';
      const model = workspace(text, { 'file:///widgets.tw': ':: W2 [widget]\n{widget "two"}two{/widget}\n' });
      const rename = () => computeRename(uri, { line: 2, character: 10 }, destination, model);
      if (['two', 'TWO', 'if'].includes(destination)) expect(rename).toThrow();
      else if (destination === 'one') expect(rename().size).toBe(0);
      else {
        const output = applied(text, rename().get(uri)!);
        expect(workspace(output).widgets.getWidget(destination)?.name).toBe(destination);
        expect(output).toContain(`{${destination}} {two}`);
      }
    });
  }
  row('RENAME-COLLISION', 'passage-existing', 'passage collision control', () => {
    const model = workspace(':: StoryVariables\n:: One\n[[Two]]\n:: Two\nx\n');
    expect(() => computeRename(uri, { line: 1, character: 4 }, 'Two', model)).toThrow();
  });

  // #94: apply the editor action, then have the runtime read the destination.
  const wrappers: Record<string, (inner: string) => string> = {
    top: inner => inner,
    'button-double': inner => `{button ${JSON.stringify(inner)}}x{/button}`,
    'button-single': inner => `{button '${inner.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' }x{/button}`,
    'attribute-double': inner => `<a title="${inner}">x</a>`,
    'attribute-single': inner => `<a title='${inner}'>x</a>`,
    'nested-button': inner => `{button ${JSON.stringify(`{button ${JSON.stringify(inner)}}x{/button}`)}}x{/button}`,
  };
  for (const [wrapper, wrap] of Object.entries(wrappers)) {
    for (const sigil of ['$', '%'] as const) {
      for (const name of sigil === '$' ? ['x', '\\u0078', '\\u{78}'] : ['x']) {
        for (const form of ['display', 'print']) {
          row('VARIABLE-SPANS', `${wrapper}-${sigil}-${name}-${form}`, 'references/prepare and rename applied/rebuilt', () => {
            const inner = form === 'display' ? `{${sigil}${name}.hp}` : `{print ${sigil}${name}.hp}`;
            const text = `:: StoryVariables\n${sigil === '$' ? '$x = {hp:1}\n' : ':: StoryTransients\n%x = {hp:1}\n'}:: Start\nbefore ${wrap(inner)} after\n`.replaceAll('\n', '\r\n');
            const model = workspace(text);
            const refs = sigil === '$' ? findVariableReferences('x', model, false) : findTransientReferences('x', model, false);
            expect(refs).toHaveLength(1);
            const position = refs[0].range.start;
            expect(prepareRename(uri, position, model)?.placeholder).toBe('x');
            const output = applied(text, computeRename(uri, position, 'renamed', model).get(uri)!);
            expect(output).toContain(wrap(form === 'display' ? `{${sigil}renamed.hp}` : `{print ${sigil}renamed.hp}`));
            expect(output).toContain('before ');
            expect(output).toContain(' after');
            expect(computeDiagnostics(uri, workspace(output)).filter(d => d.severity === 'error')).toEqual([]);
          }, 'CRLF');
        }
      }
    }
  }

  // #79: signatures and inlays use the same decoded argument coordinates.
  for (const [wrapper, wrap] of Object.entries(wrappers).filter(([name]) => name !== 'attribute-double')) {
    for (const argument of ['"two words"', "'two words'", '"a\\\"b"', '"a\\nb"']) {
      for (const complete of [true, false]) {
        row('CONFIGURED-ARGS', `source-position-${wrapper}-${argument}-${complete}`, 'signature active parameter and widget inlay source position', () => {
          const text = `:: StoryVariables\n:: W [widget]\n{widget "wid" @label @count}{@label}{/widget}\n:: Target\nx\n:: Start\n${wrap(`{wid ${argument} 2${complete ? '}' : ''}`)}\n`;
          const model = workspace(text);
          const at = text.lastIndexOf(' 2') + 1;
          const position = doc(text).positionAt(at);
          expect(getSignatureHelp(uri, position, model)?.activeParameter).toBe(1);
          if (complete) {
            const hints = computeInlayHints(uri, { start: { line: 0, character: 0 }, end: { line: 99, character: 0 } }, model).filter(h => h.label === '@count:');
            expect(hints).toHaveLength(1);
            expect(hints[0].position).toEqual(position);
          }
          const link = text.replace('{wid ', '{link ');
          const linkModel = workspace(link);
          expect(getSignatureHelp(uri, doc(link).positionAt(link.lastIndexOf(' 2') + 1), linkModel)?.activeParameter).toBe(1);
        });
      }
    }
  }

  // #104: close the innermost owning markup region, including nested labels.
  for (const [wrapper, wrap] of Object.entries(wrappers)) {
    for (const eol of ['\n', '\r\n']) {
      row('QUICKFIX-CLOSER', `${wrapper}-${eol.length}`, 'action applied/rebuilt and pairing error removal', () => {
        const text = `:: StoryVariables\n:: Start\nbefore ${wrap('{if true}hello')} after\n:: Next\nnext\n`.replaceAll('\n', eol);
        const model = workspace(text);
        const diagnostics = computeDiagnostics(uri, model).filter(d => d.code === 'SP101');
        expect(diagnostics).toHaveLength(1);
        const action = computeCodeActions(uri, diagnostics, model).find(a => a.title === 'Insert {/if}');
        expect(action).toBeDefined();
        const output = applied(text, action!.edits);
        expect(computeDiagnostics(uri, workspace(output)).filter(d => d.severity === 'error')).toEqual([]);
        if (wrapper !== 'top') expect(output).toContain(wrap('{if true}hello{/if}'));
        expect(output).toContain(`:: Next${eol}next${eol}`);
      }, eol === '\n' ? 'LF' : 'CRLF');
    }
  }

  // #103: a discovered definition replaces all executable builtin metadata.
  for (const source of ['macros.js', 'macros.ts', 'StoryInit']) {
    row('MACRO-DISCOVERY', `replacement-${source}`, 'runtime metadata/diagnostics/references/rename/state restoration', () => {
      const definitions = 'Story.defineMacro({name:"textbox",parameters:[{name:"label",type:"string"}],render(){return null;}});\nStory.defineMacro({name:"switch",block:true,render(){return null;}});';
      const text = `:: StoryVariables\n$x = 1\n${source === 'StoryInit' ? `:: StoryInit\n{do}${definitions}{/do}\n` : ''}:: Start\n{textbox "$x"}\n{switch}x{/switch}\n`;
      const model = workspace(text, source === 'StoryInit' ? {} : { [`file:///${source}`]: definitions });
      expect(model.macros.getMacro('textbox')).toMatchObject({ subMacros: [], source: 'user' });
      expect(model.macros.getMacro('textbox')?.storeVar).toBeUndefined();
      expect(model.macros.getMacro('textbox')?.interpolate).toBeUndefined();
      expect(model.macros.getMacro('switch')?.children).toBeUndefined();
      expect(model.macros.getMacro('switch')?.subMacros).toEqual([]);
      expect(findVariableReferences('x', model, false)).toEqual([]);
      expect(computeDiagnostics(uri, model).filter(d => ['SP200', 'SP115', 'SP109'].includes(d.code))).toEqual([]);
      expect(applied(text, computeRename(uri, { line: 1, character: 1 }, 'fresh', model).get(uri)!)).toContain('{textbox "$x"}');
      model.macros.loadConfig({ textbox: { parameters: ['string'], description: 'configured' } });
      expect(model.macros.getMacro('textbox')?.description).toBe('configured');
      model.macros.loadConfig({});
      if (source === 'StoryInit') model.documents.update(uri, text.replace(definitions, ''));
      else model.documents.update(`file:///${source}`, '');
      expect(model.macros.getMacro('textbox')?.storeVar).toBe(true);
      expect(findVariableReferences('x', model, false)).toHaveLength(1);
    });
  }
  for (const storeVar of [true, false]) {
    for (const interpolate of [true, false]) {
      for (const holds of ['markup', undefined]) {
        row('MACRO-DISCOVERY', `replacement-flags-${storeVar}-${interpolate}-${holds}`, 'effective flags/markup parameter behavior against public tooling', () => {
          const definition = `Story.defineMacro({name:"textbox",storeVar:${storeVar},interpolate:${interpolate},parameters:[{name:"label",type:"string"${holds ? ',holds:"markup"' : ''}}],render(){}});`;
          const found = discoverMacros(definition)[0];
          const content = '{textbox "$x"}\n{textbox "{$x}"}';
          const text = `:: StoryVariables\n$x = 1\n:: Start\n${content}\n`;
          const model = workspace(text, { 'file:///macros.js': definition });
          expect(model.macros.getMacro('textbox')?.storeVar).toBe(found.storeVar);
          expect(model.macros.getMacro('textbox')?.interpolate).toBe(found.interpolate);
          const macros = builtinMacros.map(m => m.name === 'textbox' ? found : m);
          expect(findVariableReferences('x', model, false)).toHaveLength(variableReferences(content, macros, { all: true }).filter(r => r.name === 'x').length);
          expect(model.markup.get(uri)!.passages[1].pieces.map(p => p.kind)).toEqual(passagePieces(content + '\n', macros).map(p => p.kind));
        });
      }
    }
  }

  // #106: configured passage parameters read actual JavaScript literal values.
  for (const argument of ['"Target"', "'Target'", '"\\u0054arget"', "'\\u0054arget'", '"a\\\\b"', '"a\\\"b"', "'a\\\'b'", '"Missing"']) {
    for (const [wrapper, wrap] of Object.entries(wrappers).filter(([name]) => !name.startsWith('attribute'))) {
      row('CONFIGURED-ARGS', `passage-literal-${wrapper}-${argument}`, 'configured diagnostics against public passageTarget', () => {
        const target = passageTarget(argument);
        expect(target.kind).toBe('name');
        const name = target.kind === 'name' ? target.name : '';
        const text = `:: StoryVariables\n:: Start\n${wrap(`{custom ${argument}}`)}\n:: ${name === 'Missing' ? 'Target' : name.replace(/\\/g, '\\\\')}\nx\n`;
        const model = workspace(text, { 'file:///macros.js': 'Story.defineMacro({name:"custom",parameters:[{name:"p",type:"passage"}],render(){return null;}});' });
        model.macros.loadConfig({ custom: { parameters: ['passage'] } });
        expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP110')).toHaveLength(name === 'Missing' ? 1 : 0);
      });
    }
  }

  // #107: only executable reads make a loop assignment risky.
  for (const read of ['<!-- _x -->', '{print "_x"}', '{print /_x/.test("x")}', '{print `_x`}', 'plain _x text', '{_x}', '{print `${_x}`}', '{print _x}', '{set _x = 2}', '{set _x /* comment */ = 2}']) {
    row('TEMP-LOOP', read, 'SP205 lexical contexts with real read controls', () => {
      const text = `:: StoryVariables\n:: Start\n{for @n of [1,2]}{set _x = @n}${read}{/for}\n`;
      const risky = ['{_x}', '{print `${_x}`}', '{print _x}'].includes(read);
      expect(computeDiagnostics(uri, workspace(text)).filter(d => d.code === 'SP205')).toHaveLength(risky ? 1 : 0);
    });
  }

  // #35/#108/#109: every consumer shares compiler header boundaries and decoded tags.
  for (const prefix of ['::', ':: ', '::\t', 'mixed']) {
    for (const eol of ['\n', '\r\n']) {
      row('HEADER', `${prefix}-${eol.length}`, 'index/diagnostics/navigation/rename/outline/format boundaries', async () => {
        const headers = prefix === 'mixed' ? ['::StoryVariables', ':: Start', '::\tTarget'] : ['StoryVariables', 'Start', 'Target'].map(name => prefix + name);
        const text = `\uFEFF${headers[0]}\n$x = 1\n${headers[1]}\n[[Target]]\n${headers[2]}\n{if true}\n`.replaceAll('\n', eol);
        const model = workspace(text);
        expect(model.passages.getAllPassages().map(p => p.name)).toEqual(['StoryVariables', 'Start', 'Target']);
        expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP101')).toHaveLength(1);
        expect(computeDocumentSymbols(uri, model).map(s => s.name)).toEqual(['StoryVariables', 'Start', 'Target']);
        expect(splitPassages(text).map(p => p.header)).toHaveLength(3);
        const position = doc(text).positionAt(text.indexOf('[[Target]]') + 3);
        expect(getDefinition(uri, position, model)?.uri).toBe(uri);
        const output = applied(text, computeRename(uri, position, 'Fresh', model).get(uri)!);
        expect(workspace(output).passages.getPassage('Fresh')).toBeDefined();
        const formatted = await formatDocument(text);
        expect(workspace(formatted).passages.getAllPassages().map(p => p.name)).toEqual(['StoryVariables', 'Start', 'Target']);
        expect(await formatDocument(formatted)).toBe(formatted);
      }, eol === '\n' ? 'LF/BOM' : 'CRLF/BOM');
    }
  }
  const tagSpellings: Array<[string, string[]]> = [
    ['script', ['script']], ['scri\\pt', ['script']],
    ['stylesheet', ['stylesheet']], ['style\\sheet', ['stylesheet']],
    ['script extra', ['script', 'extra']], ['Script', ['Script']], ['SCRIPT', ['SCRIPT']],
    ['Stylesheet', ['Stylesheet']], ['STYLESHEET', ['STYLESHEET']],
    ['foo\\[bar\\]', ['foo[bar]']], ['one\\ two', ['one', 'two']],
    ['script\\ ', ['script']], ['\\ script', ['script']],
  ];
  for (const [tag, decoded] of tagSpellings) {
    row('FORMAT-ROLE', tag, 'decoded tags/role exclusions/format payload and idempotence', async () => {
      const header = `:: Code [${tag}]`;
      expect(parsePassageHeader(header, 0)?.tags).toEqual(decoded);
      const kind = decoded.includes('script') ? 'script' : decoded.includes('stylesheet') ? 'stylesheet' : 'normal';
      expect(classifyPassage(header)).toBe(kind);
      const body = kind === 'stylesheet' ? '.a{color:red}\n' : kind === 'script' ? 'const s = "{nosuch} [[Missing]]";\n' : 'foo( 1 );\n';
      const text = `:: StoryVariables\n${header}\n${body}`;
      const model = workspace(text);
      expect(model.markup.get(uri)!.passages[1].isMarkup).toBe(kind === 'normal');
      if (kind !== 'normal') {
        expect(computeDiagnostics(uri, model).filter(d => ['SP100', 'SP300'].includes(d.code))).toEqual([]);
        expect(findPassageReferences('Missing', model, false)).toEqual([]);
      }
      const output = await formatDocument(text);
      if (kind === 'normal') {
        const ordinary = await formatDocument(text.replace(header, ':: Code'));
        expect(output).toBe(ordinary.replace(':: Code', header));
      }
      expect(await formatDocument(output)).toBe(output);
    });
  }
  for (const spelling of ['{$\\u0078.hp}', '{print $\\u0078.hp}', '{$x.hp}']) {
    row('VARIABLE-SPANS', `declaration-cross-file-${spelling}`, 'exact reported source escape, cross-document applied rename', () => {
      const definition = 'file:///declarations.tw';
      const declaration = ':: StoryVariables\n$x = {hp:1}\n';
      const text = `:: Start\n{button "${spelling}"}ok{/button}\n`;
      const model = workspace(text, { [definition]: declaration });
      const edits = computeRename(definition, { line: 1, character: 1 }, 'renamed', model);
      const output = applied(text, edits.get(uri)!);
      const declarations = TextDocument.applyEdits(TextDocument.create(definition, 'twee', 0, declaration), edits.get(definition)!);
      const rebuilt = workspace(output, { [definition]: declarations });
      expect(output).toContain(spelling.startsWith('{print') ? '{print $renamed.hp}' : '{$renamed.hp}');
      expect(computeDiagnostics(uri, rebuilt).filter(d => d.severity === 'error')).toEqual([]);
      expect(findVariableReferences('renamed', rebuilt, false)).toHaveLength(1);
    });
  }
  row('FORMAT-ROLE', 'escaped-script-discovery-and-literal-preservation', 'discovery/diagnostics/rename exclusion', () => {
    const text = ':: StoryVariables\n$x = 1\n:: Code [scri\\pt]\nconst s = "{$x} [[Target]]";\nStory.defineMacro({name:"custom",render(){}});\n:: Start\n{$x} {custom}\n:: Target\nx\n';
    const model = workspace(text);
    expect(model.macros.getMacro('custom')).toBeDefined();
    expect(computeDiagnostics(uri, model).filter(d => d.severity === 'error')).toEqual([]);
    const output = applied(text, computeRename(uri, { line: 1, character: 1 }, 'fresh', model).get(uri)!);
    expect(output).toContain('const s = "{$x} [[Target]]";');
    expect(output).toContain('{$fresh} {custom}');
    expect(findPassageReferences('Target', model, false)).toEqual([]);
  });
  for (const [wrapper, wrap] of Object.entries(wrappers)) {
    for (const spelling of ['double', 'single', 'bare']) {
      if ((wrapper === 'attribute-double' && spelling === 'double') || (wrapper === 'attribute-single' && spelling === 'single')) continue;
      for (const eol of ['\n', '\r\n']) {
        row('QUICKFIX-PASSAGE', `${wrapper}-${spelling}-${eol === '\n' ? 'lf' : 'crlf'}`, 'diagnostics/code action applied/runtime identity', () => {
          const target = spelling === 'bare' ? 'Target' : 'Trget';
          const arg = spelling === 'double' ? JSON.stringify(target) : spelling === 'single' ? `'${target}'` : target;
          const markup = wrap(`{goto ${arg}}`);
          const text = `:: StoryVariables\n:: Target\nx\n:: Start\nbefore ${markup} after\n`.replaceAll('\n', eol);
          const model = workspace(text);
          const code = spelling === 'bare' ? 'SP113' : 'SP300';
          const diagnostics = computeDiagnostics(uri, model).filter(d => d.code === code);
          expect(diagnostics).toHaveLength(1);
          const action = computeCodeActions(uri, diagnostics, model).find(a => spelling === 'bare' ? a.title.startsWith('Quote') : a.title === "Change to 'Target'");
          expect(action).toBeDefined();
          const output = applied(text, action!.edits);
          const rebuilt = workspace(output);
          expect(computeDiagnostics(uri, rebuilt).filter(d => d.severity === 'error')).toEqual([]);
          const passage = rebuilt.markup.get(uri)!.passages.find(p => p.passage.name === 'Start')!;
          expect(passage.pieces.filter(p => p.kind === 'passage').map(p => p.name)).toEqual(['Target']);
          expect(output).toContain('before ');
          expect(output).toContain(' after');
        }, eol === '\n' ? 'LF' : 'CRLF');
      }
    }
  }

  // #95: collisions in prose, attributes, comments and restored payloads.
  for (const marker of ['__SP0__', '<!--SP:0-->', '<!--SVG:0-->', '__SPX0__ <!--SPX:0-->']) {
    for (const eol of ['\n', '\r\n']) {
      row('FORMAT-MARKER', `${marker}-${eol === '\n' ? 'lf' : 'crlf'}`, 'format payload/order/idempotence', async () => {
        const text = `:: StoryVariables\n:: Start\n<div>\n${marker}\n<span title='${marker}'>{print "${marker}"}</span>\n{print "payload"}\n<svg><text>${marker}</text></svg>\n</div>\n`.replaceAll('\n', eol);
        const output = await formatDocument(text);
        const payloads = (source: string) => passagePieces(source.split(':: Start' + eol)[1], builtinMacros).filter(p => p.kind === 'code').map(p => p.code);
        expect(payloads(output)).toEqual(payloads(text));
        for (const literal of marker.split(' ')) expect(output.split(literal)).toHaveLength(text.split(literal).length);
        expect(output.indexOf(marker)).toBeLessThan(output.indexOf('{print "payload"}'));
        expect(output).toContain(`<svg><text>${marker}</text></svg>`);
        expect(await formatDocument(output)).toBe(output);
      });
    }
  }

  // #97: runtime definitions own the outline, including multi-line selection ranges.
  for (const eol of ['\n', '\r\n']) {
    for (const role of ['W [widget]', 'StoryInit']) {
      row('OUTLINE-WIDGET', `${role}-${eol === '\n' ? 'lf' : 'crlf'}`, 'outline/registry/public definition agreement', () => {
        const content = '<!-- {widget "fake"}ignored{/widget} -->\n{widget\n "multiline" @value}\n{@value}\n{/widget}\n{widget "one-line"}x{/widget}\n{set _x = \'{widget "string"}x{/widget}\'}\n';
        const text = `:: StoryVariables\n:: ${role}\n${content}`.replaceAll('\n', eol);
        const model = workspace(text);
        const children = computeDocumentSymbols(uri, model).find(s => s.name === role.split(' ')[0])!.children!;
        const definitions = widgetDefinitions([{ name: role.split(' ')[0], tags: role.includes('[widget]') ? ['widget'] : [], content }]);
        expect(children.map(s => s.name)).toEqual(definitions.map(d => d.name));
        expect(children.map(s => s.name)).toEqual(['multiline', 'one-line']);
        for (const symbol of children) {
          expect(doc(text).getText(symbol.selectionRange)).toBe(symbol.name);
          expect(symbol.selectionRange).toEqual(model.widgets.getWidget(symbol.name)!.nameRange);
        }
      });
    }
  }

  const outlineBoundaries = {
    'complete-head-no-close': '{widget "unfinished" @value}',
    'multiline-head-no-close': '{widget\n "unfinished" @value}\ntext',
    'incomplete-head': '{widget "unfinished"',
    'escaped-name': '{widget "escaped\\\"name"}x{/widget}',
  };
  for (const [boundary, content] of Object.entries(outlineBoundaries)) {
    for (const eol of ['\n', '\r\n']) {
      row('OUTLINE-WIDGET', `${boundary}-${eol === '\n' ? 'lf' : 'crlf'}`, 'outline names/exact source spans vs tooling', () => {
        const text = `:: StoryVariables\n:: W [widget]\n${content}\n`.replaceAll('\n', eol);
        const model = workspace(text);
        const passage = model.markup.get(uri)!.passages.find(p => p.passage.name === 'W')!;
        const definitions = widgetDefinitions([{ name: 'W', tags: ['widget'], content: passage.content }], builtinMacros);
        const children = computeDocumentSymbols(uri, model).find(s => s.name === 'W')!.children!;
        expect(children.map(s => s.name)).toEqual(definitions.map(d => d.name));
        expect(children.map(s => s.selectionRange)).toEqual(definitions.map(d => passage.range(d.nameStart, d.nameEnd)));
        expect(children.map(s => doc(text).getText(s.selectionRange))).toEqual(definitions.map(d => passage.content.slice(d.nameStart, d.nameEnd)));
      }, eol === '\n' ? 'LF' : 'CRLF');
    }
  }

  // #98: accepting a completion must read the selected field, using both sigils.
  for (const sigil of ['$', '%'] as const) {
    for (const key of ['name', 'first-name', 'two words', '5key', 'a"b', "a'b", 'a\\b']) {
      for (const [wrapper, wrap] of Object.entries(wrappers).filter(([name]) => ['top', 'button-double', 'attribute-double', 'attribute-single'].includes(name))) {
      for (const suffix of ['', 'fi§rst']) {
        row('COMPLETION-FIELD', `${sigil}-${key}-${wrapper}-${suffix || 'empty'}`, 'completion applied/runtime evaluated on benign fixture', () => {
          const declarations = `:: StoryVariables\n${sigil === '$' ? '$p' : ''}${sigil === '$' ? ` = {${JSON.stringify(key)}:"Ada"}\n` : ''}:: StoryTransients\n${sigil === '%' ? `%p = {${JSON.stringify(key)}:"Ada"}\n` : ''}`;
          const marked = `:: Start\n${wrap(`{${sigil}p.${suffix || '§'}}`)}\n`;
          const offset = marked.indexOf('§');
          const text = marked.replace('§', '');
          const model = workspace(text, { 'file:///declarations.tw': declarations });
          const completion = getCompletions(uri, doc(text).positionAt(offset), '.', model).find(item => item.label === key)!;
          expect(completion).toBeDefined();
          const output = applied(text, [completion.textEdit as any]);
          const pieces = passagePieces(output.split(':: Start\n')[1], builtinMacros);
          const code = pieces.find(p => p.kind === 'code');
          const variable = [...tokenizeMarkupTolerant(output.split(':: Start\n')[1]).tokens, ...pieces.flatMap(p => p.kind === 'text' ? p.tokens : [])].find(t => t.type === 'variable');
          expect(code || variable).toBeDefined();
          const expression = code?.kind === 'code' ? code.code : `${sigil}${variable!.type === 'variable' ? variable!.name : ''}`;
          expect(pieces.flatMap(p => p.kind === 'text' ? p.errors : [])).toEqual([]);
          const values = { p: { [key]: 'Ada' } };
          const value = evaluate(expression, values, {}, {}, values);
          expect(value).toBe('Ada');
          expect(workspace(output, { 'file:///declarations.tw': declarations }).variables[sigil === '$' ? 'getDeclared' : 'getDeclaredTransient']().get('p')?.fields).toContain(key);
        });
      }
      }
    }
  }

  // #99: normalize empty YAML/JSON metadata; reject a reload atomically.
  for (const format of ['yaml', 'json'] as const) {
    for (const name of ['foo', 'if']) {
      row('CONFIG-ENTRY', `${format}-null-${name}`, 'configuration load/registry/no crash', () => {
        const config = parseConfig(format === 'yaml' ? `macros:\n  ${name}:\n` : JSON.stringify({ macros: { [name]: null } }), format);
        const model = workspace(':: StoryVariables\n:: Start\nx\n');
        model.macros.loadConfig(config.macros);
        expect(model.macros.getMacro(name)).toBeDefined();
        expect(config.macros[name]).toEqual({});
      });
    }
  }
  for (const invalid of [1, false, 'bad', [], { parameters: 'number' }, { container: [] }, { parameterDocs: [null] }, { children: [null] }]) {
    row('CONFIG-ENTRY', `reject-${JSON.stringify(invalid)}`, 'atomic registry reload rejection', () => {
      const model = workspace(':: StoryVariables\n:: Start\n{usable}\n');
      model.macros.loadConfig({ usable: { description: 'keep' } });
      expect(() => model.macros.loadConfig({ invalid } as any)).toThrow();
      expect(model.macros.getMacro('usable')?.description).toBe('keep');
      expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP100')).toEqual([]);
    });
  }

  // #101: schema diagnostics and signature help share runtime argument boundaries.
  const argumentsTable = ['(1 + 2)', '[1, 2]', '{a: 1}', '`a ${1}`', '$5', '1', '"wrong"'];
  for (const arg of argumentsTable) {
    row('CONFIGURED-ARGS', arg, 'splitArgs/diagnostics/signature classification', () => {
      const text = `:: StoryVariables\n$5 = 1\n:: Start\n{custom ${arg} 3}\n`;
      const model = workspace(text, { 'file:///macros.js': 'Story.defineMacro({name:"custom", parameters:[{name:"first",type:"expression"},{name:"second",type:"expression"}], render(){return null;}});' });
      model.macros.loadConfig({ custom: { parameters: ['number &+ number', 'string &+ string'] } });
      const raw = `${arg} 3`;
      expect(lexArguments(raw).map(a => a.text)).toEqual(splitArgs(raw));
      const errors = computeDiagnostics(uri, model).filter(d => ['SP108', 'SP109', 'SP110'].includes(d.code));
      expect(errors.length).toBe(arg === '"wrong"' ? 1 : 0);
      const help = getSignatureHelp(uri, { line: 3, character: `{custom ${arg} `.length }, model)!;
      expect(help.activeParameter).toBe(1);
      expect(help.activeSignature).toBe(arg === '"wrong"' ? 1 : 0);
    });
  }

  // Reverify historical open tickets #18/#27/#37 against the current tooling migration.
  for (const sigil of ['$', '%'] as const) {
    row('DECLARATION-LOCATION', sigil, 'references/rename/workspace symbols', () => {
      const text = `${sigil === '$' ? ':: StoryVariables' : ':: StoryVariables\n:: StoryTransients'}\n${sigil}x = null\n:: Start\n{${sigil}x}\n`;
      const model = workspace(text);
      const refs = sigil === '$' ? findVariableReferences('x', model, true) : findTransientReferences('x', model, true);
      expect(refs).toHaveLength(2);
      expect(refs.every(ref => ref.uri === uri && doc(text).getText(ref.range) === `${sigil}x`)).toBe(true);
      const output = applied(text, computeRename(uri, refs[1].range.start, 'fresh', model).get(uri)!);
      expect(output).toContain(`${sigil}fresh = null`);
      expect(output).toContain(`{${sigil}fresh}`);
      if (sigil === '$') expect(searchWorkspaceSymbols('$x', model)[0].uri).toBe(uri);
    });
  }
  row('MACRO-DISCOVERY', 'StoryInit-edit', 'discovery/diagnostics/state refresh', () => {
    const text = ':: StoryVariables\n:: StoryInit\n{do}\nStory.defineMacro({name:"hello", render:()=>"hello"});\n{/do}\n:: Start\n{hello}\n';
    const model = workspace(text);
    expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP100')).toEqual([]);
    model.documents.update(uri, text.replace('name:"hello"', 'name:"other"'));
    expect(model.macros.getMacro('hello')).toBeUndefined();
    expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP100')).toHaveLength(1);
  });
  for (const args of ["'Target'", '"Target" inline', 'inline "Target"']) {
    row('PASSAGE-LITERALS', args, 'references/definition/rename existing contract control', () => {
      const text = `:: StoryVariables\n:: Start\n{include ${args}}\n:: Target\nx\n`;
      const model = workspace(text);
      expect(findPassageReferences('Target', model, false)).toHaveLength(1);
      const output = applied(text, computeRename(uri, { line: 3, character: 4 }, 'Fresh', model).get(uri)!);
      expect(findPassageReferences('Fresh', workspace(output), false)).toHaveLength(1);
    });
  }
}
