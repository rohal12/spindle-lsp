/** October 16 extensions of the existing literal, header and widget contracts. */
import { afterEach, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { builtinMacros, parseDeclarations, passagePieces, widgetDefinitions } from '@rohal12/spindle/tooling';
import { WorkspaceModel } from '../../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../../src/plugins/diagnostics.js';
import { computeCodeActions } from '../../../src/plugins/code-actions.js';
import { computeRename, prepareRename } from '../../../src/plugins/rename.js';
import { getDefinition } from '../../../src/plugins/definition.js';
import { findPassageReferences, findVariableReferences, findTransientReferences } from '../../../src/plugins/references.js';
import { computeCodeLenses } from '../../../src/plugins/code-lens.js';
import { formatDocument } from '../../../src/plugins/format.js';
import { parsePassageHeader } from '../../../src/core/parsing/passage-parser.js';
import { evaluate } from '../../helpers/expression-oracle.js';
import type { Dims } from './harness.js';

type Cell = (id: string, dims: Dims, run: () => void | Promise<void>) => void;
const uri = 'file:///audit.tw';
const definitionsUri = 'file:///definitions.tw';
const models: WorkspaceModel[] = [];
function model(files: Map<string, string>) {
  const workspace = new WorkspaceModel();
  models.push(workspace);
  workspace.initialize(files);
  return workspace;
}
function document(text: string, path = uri) { return TextDocument.create(path, 'twee', 0, text); }
function apply(files: Map<string, string>, edits: Map<string, any[]>) {
  return new Map([...files].map(([path, text]) => [path, TextDocument.applyEdits(document(text, path), edits.get(path) ?? [])]));
}

export function registerAuditContracts(cell: Cell): void {
  afterEach(() => { for (const workspace of models.splice(0)) workspace.dispose(); });
  const row = (family: string, variant: string, consumer: string, run: () => void | Promise<void>) =>
    cell(`N/${family}/${variant}`, { role: 'ordinary/declarations/widgets', context: family, spelling: variant, boundary: 'LF/CRLF', state: 'same-file/cross-file/rebuilt', consumer }, run);

  // #66: payloads that are not markup never enter the prose wrapper.
  const literal = 'this is a fairly long string that contains words and spaces';
  for (const role of ['StoryVariables', 'StoryTransients', 'StoryData', 'SaveTitle', 'StoryTitle']) {
    for (const eol of ['\n', '\r\n']) {
      row('FORMAT-ROLE', `${role}/wrapping/${eol.length}`, 'runtime payload preservation and idempotence', async () => {
        const body = role === 'StoryVariables' ? `$msg = ${JSON.stringify(literal)}`
          : role === 'StoryTransients' ? `%msg = ${JSON.stringify(literal)}`
          : role === 'StoryData' ? JSON.stringify({ label: literal })
          : role === 'SaveTitle' ? `return ${JSON.stringify(literal)};` : literal;
        const text = `:: ${role}\n${body}\n:: Start\n${literal}\n`.replaceAll('\n', eol);
        const output = await formatDocument(text, { maxLineLength: 25 });
        const workspace = model(new Map([[uri, output]]));
        const payload = workspace.markup.get(uri)!.passages[0].content.trim();
        expect(payload).toBe(body);
        if (role === 'StoryVariables' || role === 'StoryTransients') {
          const parsed = parseDeclarations(payload, role === 'StoryVariables' ? '$' : '%');
          expect(parsed.errors).toEqual([]);
          expect(parsed.declarations).toHaveLength(1);
        } else if (role === 'StoryData') expect(JSON.parse(payload).label).toBe(literal);
        else if (role === 'SaveTitle') expect(evaluate(payload.slice(7, -1))).toBe(literal);
        expect(output).toContain(`:: Start${eol}this is a fairly long${eol}`);
        expect(await formatDocument(output, { maxLineLength: 25 })).toBe(output);
      });
    }
  }

  // #108: edits and declaration extraction share the indexed passage boundary.
  for (const sigil of ['$', '%'] as const) for (const eol of ['\n', '\r\n']) {
    for (const prefix of ['::', ':: ']) for (const destination of ['same', 'other', 'eof', 'header-only', 'adjacent']) {
      row('HEADER', `declare-${sigil}/${eol.length}/${prefix.length}/${destination}`, 'applied quick fix, runtime declaration and unchanged following passage', () => {
        const name = sigil === '$' ? 'StoryVariables' : 'StoryTransients';
        const next = `${prefix}Start\n{print ${sigil}missing}\n`;
        const declarations = `${prefix}${name}${destination === 'header-only' ? '' : `\n${sigil}known = 0`}`;
        const separate = destination !== 'same' && destination !== 'adjacent';
        const source = separate ? `${sigil === '%' ? ':: StoryVariables\n' : ''}${next}` : `${sigil === '%' ? '::StoryVariables\n' : ''}${declarations}\n${destination === 'adjacent' ? `::${sigil === '$' ? 'StoryTransients' : 'Other'}\n'unchanged'\n` : ''}${next}`;
        const target = declarations + (['eof', 'header-only'].includes(destination) ? '' : '\n::After\nuntouched\n');
        const files = new Map([[uri, source.replaceAll('\n', eol)], ...(separate ? [[definitionsUri, target.replaceAll('\n', eol)] as [string, string]] : [])]);
        const workspace = model(files);
        const diagnostic = computeDiagnostics(uri, workspace).find(d => d.code === (sigil === '$' ? 'SP200' : 'SP203'))!;
        expect(diagnostic).toBeDefined();
        const action = computeCodeActions(uri, [diagnostic], workspace).find(a => a.title.startsWith('Declare'))!;
        expect(action).toBeDefined();
        const changes = new Map<string, any[]>();
        for (const edit of action.edits) changes.set(edit.uri, [...(changes.get(edit.uri) ?? []), edit]);
        const output = apply(files, changes);
        const rebuilt = model(output);
        expect(computeDiagnostics(uri, rebuilt).filter(d => d.code === diagnostic.code)).toEqual([]);
        const passage = rebuilt.passages.getPassage(name)!;
        const parsed = rebuilt.markup.get(passage.uri)!.passages.find(p => p.passage === passage)!.declarations;
        expect(parsed.errors).toEqual([]);
        expect(parsed.declarations.map(d => d.name)).toContain('missing');
        expect(output.get(uri)).toContain(next.replaceAll('\n', eol));
        if (separate) expect(output.get(definitionsUri)).toContain(destination === 'other' ? '::After' : `${sigil}missing = 0`);
        // An apparent declaration in the next passage never enters the tracker.
        const changed = new Map(output);
        changed.set(uri, output.get(uri)! + `${sigil}prose = 42${eol}`);
        const indexed = model(changed);
        const declared = sigil === '$' ? indexed.variables.getDeclared() : indexed.variables.getDeclaredTransient();
        expect(declared.has('prose')).toBe(false);
      });
    }
  }

  // #112: forward opaque runtime definitions, never parse their annotations here.
  for (const role of ['passage', 'expression', 'statements', 'markup', 'text', 'unannotated']) {
    for (const context of ['top-level', 'label', 'attribute']) for (const separate of [false, true]) {
      for (const sigil of ['$', '%'] as const) {
        row('WIDGET-HOLDS', `${role}/${context}/${separate ? 'cross-file' : 'same-file'}/${sigil}`, 'diagnostics/navigation/references/lenses/applied rename/runtime pieces', () => {
          const defs = `:: W [widget]\n{widget "Show" @arg${role === 'unannotated' ? '' : ':' + role}}{@arg}{/widget}\n`;
          const argument = role === 'passage' ? 'Hall' : role === 'markup' ? `{${sigil}gold}` : `${sigil}gold + 1`;
          const call = `{Show ${JSON.stringify(argument)}}`;
          const wrapped = context === 'label' ? `{button ${JSON.stringify(call)}}ok{/button}` : context === 'attribute' ? `<div title='${call}'>ok</div>` : call;
          const text = `::StoryVariables\n${sigil === '$' ? '$gold = 1\n' : '::StoryTransients\n%gold = 1\n'}${separate ? '' : defs}::Start\n${wrapped}\n{include "Hall"}\n{print ${sigil}gold}\n::Hall\nHello\n`;
          const files = new Map([[uri, text], ...(separate ? [[definitionsUri, defs] as [string, string]] : [])]);
          const workspace = model(files);
          expect(computeDiagnostics(uri, workspace).filter(d => d.severity === 'error')).toEqual([]);
          const executable = !['text', 'unannotated'].includes(role);
          const refs = role === 'passage' ? findPassageReferences('Hall', workspace, false)
            : sigil === '$' ? findVariableReferences('gold', workspace, false) : findTransientReferences('gold', workspace, false);
          expect(refs).toHaveLength(executable ? 2 : 1);
          const argOffset = text.indexOf(role === 'passage' ? 'Hall' : `${sigil}gold`, text.indexOf('::Start'));
          const position = document(text).positionAt(argOffset + 1);
          if (role === 'passage') expect(!!getDefinition(uri, position, workspace)).toBe(executable);
          expect(!!prepareRename(uri, position, workspace)).toBe(executable);
          const at = document(text).positionAt(role === 'passage' ? text.lastIndexOf('Hall') + 1 : text.indexOf(`${sigil}gold`) + 1);
          const output = apply(files, computeRename(uri, at, role === 'passage' ? 'Lobby' : 'money', workspace));
          const rebuilt = model(output);
          expect(computeDiagnostics(uri, rebuilt).filter(d => d.severity === 'error')).toEqual([]);
          const changed = output.get(uri)!;
          const destination = role === 'passage' ? 'Lobby' : 'money';
          const found = role === 'passage' ? findPassageReferences(destination, rebuilt, false)
            : sigil === '$' ? findVariableReferences(destination, rebuilt, false) : findTransientReferences(destination, rebuilt, false);
          expect(found).toHaveLength(executable ? 2 : 1);
          if (!executable) expect(changed).toContain(wrapped);
          const runtimeDefs = widgetDefinitions([{ name: 'W', tags: ['widget'], content: defs.slice(defs.indexOf('{widget')) }]);
          const macros = [...builtinMacros, ...runtimeDefs.map(widget => ({ name: widget.name, block: widget.block, subMacros: [], widget }))];
          const pieces = passagePieces(rebuilt.markup.get(uri)!.passages.find(p => p.passage.name === 'Start')!.content, macros);
          if (role === 'passage') expect(pieces.filter(p => p.kind === 'passage').map(p => p.name)).toEqual(['Lobby', 'Lobby']);
          const lensLine = role === 'passage' ? document(changed).positionAt(changed.lastIndexOf('Lobby')).line : document(changed).positionAt(changed.indexOf(`${sigil}money`)).line;
          if (role === 'passage' || sigil === '$') expect(computeCodeLenses(uri, rebuilt).find(l => l.range.start.line === lensLine)?.command?.title).toMatch(executable ? /2/ : /1/);
          if (executable && role !== 'passage') {
            const missing = new Map(files);
            missing.set(uri, text.replaceAll(`${sigil}gold = 1`, ''));
            expect(computeDiagnostics(uri, model(missing)).filter(d => d.code === (sigil === '$' ? 'SP200' : 'SP203'))).toHaveLength(2);
          }
        });
      }
    }
  }

  for (const initial of [':passage', ':expression', ':text']) {
    row('WIDGET-HOLDS', `state/${initial}`, 'widget annotation edit/removal and macro precedence invalidate every consumer', () => {
      const defs = `::W [widget]\n{widget "Show" @arg${initial}}{@arg}{/widget}\n`;
      const text = '::StoryVariables\n$gold = 1\n::Start\n{Show "Hall"}\n::Hall\nhi\n';
      const workspace = model(new Map([[uri, text], [definitionsUri, defs]]));
      workspace.documents.update(definitionsUri, defs.replace(initial, ':passage'));
      expect(findPassageReferences('Hall', workspace, false)).toHaveLength(1);
      workspace.documents.update(definitionsUri, defs.replace(initial, ':text'));
      expect(findPassageReferences('Hall', workspace, false)).toHaveLength(0);
      workspace.documents.update(definitionsUri, defs.replace(initial, ':passage'));
      expect(findPassageReferences('Hall', workspace, false)).toHaveLength(1);
      workspace.documents.open('file:///macros.js', 'Story.defineMacro({name:"Show",parameters:[{name:"arg",type:"string"}],render(){return null;}});');
      expect(findPassageReferences('Hall', workspace, false)).toHaveLength(0);
      workspace.documents.close('file:///macros.js');
      workspace.documents.close(definitionsUri);
      expect(findPassageReferences('Hall', workspace, false)).toHaveLength(0);
    });
  }

  for (const suffix of [' [widget]', ' {"key":{"value":"[x]"}}', ' [a\\[b\\]] {"key":1}', '']) {
    row('HEADER', `delimiter-control/${suffix}`, 'escape-aware tags/meta/names and UTF-16 ranges', () => {
      const line = `\uFEFF::Name\\[x\\]${suffix}\r`;
      const parsed = parsePassageHeader(line, 0)!;
      expect(parsed.name).toBe('Name[x]');
      expect(line.slice(parsed.nameRange.start.character, parsed.nameRange.end.character)).toBe('Name\\[x\\]');
    });
  }
}
