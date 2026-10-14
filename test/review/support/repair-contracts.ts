/** Ticket-owned behavior tables shared by unit tests and retained named cells. */
import { afterEach, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { builtinMacros, passagePieces, parseStoryVariables, splitArgs, tokenizeMarkupTolerant, widgetDefinitions } from '@rohal12/spindle/tooling';
import { WorkspaceModel } from '../../../src/core/workspace/workspace-model.js';
import { computeRename } from '../../../src/plugins/rename.js';
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
function workspace(text: string, extra: Record<string, string> = {}): WorkspaceModel {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text], ...Object.entries(extra)]));
  return model;
}
function doc(text: string) { return TextDocument.create(uri, 'twee', 0, text); }
function applied(text: string, edits: Parameters<typeof TextDocument.applyEdits>[1]) { return TextDocument.applyEdits(doc(text), edits); }

export function registerRepairContracts(cell: Cell): void {
  afterEach(() => { for (const model of models.splice(0)) model.dispose(); });
  const row = (family: string, spelling: string, consumer: string, run: () => void | Promise<void>, boundary = 'LF') =>
    cell(`N/${family}/${spelling}`, { role: 'ordinary/declarations', context: family, spelling, boundary, state: 'multi-file/rebuilt', consumer }, run);

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
