/**
 * Interactive consumers of the matrix: completion applied through its
 * textEdit then re-read by the runtime, signature help against the runtime's
 * macro tokens, and the CLI / LSP entrypoints against the in-process
 * consumers. Cells are registered through the `cell` function of
 * convergence.review.ts.
 */
import { afterAll, expect, inject } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
  createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CompletionItem } from 'vscode-languageserver';
import { tokenize } from '../../../node_modules/@rohal12/spindle/src/markup/tokenizer.js';
import { buildAST, registerBlockMacro, unregisterBlockMacro } from '../../../node_modules/@rohal12/spindle/src/markup/ast.js';
import { parseStoryVariables } from '../../../node_modules/@rohal12/spindle/src/story-variables.js';
import { getCompletions } from '../../../src/plugins/completions.js';
import { getSignatureHelp } from '../../../src/plugins/signature.js';
import { computeDiagnostics } from '../../../src/plugins/diagnostics.js';
import { computeDocumentLinks } from '../../../src/plugins/document-link.js';
import { computeCodeLenses } from '../../../src/plugins/code-lens.js';
import { findReferences } from '../../../src/plugins/references.js';
import { getDefinition } from '../../../src/plugins/definition.js';
import { computeRename, prepareRename } from '../../../src/plugins/rename.js';
import { WorkspaceModel } from '../../../src/core/workspace/workspace-model.js';
import { runtimeBracketLink } from '../../helpers/link-macro-oracle.js';
import { build, cursorOffsets, doc, notApplicable, rangeProblem, root, type Dims, type Files } from './harness.js';
import { runtimePassageRefs, runtimeTokens, splitPassages } from './oracle.js';

type CellFn = (id: string, dims: Dims, fn: () => void | Promise<void>) => void;
interface Ctx {
  files: (story: string, extra?: Files) => Files;
  BASE: string;
  TARGET_FILE: string;
}

const CURSOR = '§';

/** Split a fixture at its cursor marker. */
function at(text: string): { text: string; offset: number } {
  const offset = text.indexOf(CURSOR);
  expect(offset, 'fixture has no cursor marker').toBeGreaterThanOrEqual(0);
  return { text: text.replace(CURSOR, ''), offset };
}

function complete(files: Files, story: string, extraFiles: Files = {}): { items: CompletionItem[]; text: string; offset: number; uri: string } {
  const cursor = at(story);
  const all = { ...files, 'story.tw': cursor.text, ...extraFiles };
  const model = build(all);
  const uri = 'file:///story.tw';
  const position = doc(cursor.text).positionAt(cursor.offset);
  const items = getCompletions(uri, position, undefined, model);
  return { items, text: cursor.text, offset: cursor.offset, uri };
}

/** Apply an item's textEdit (a client without one would guess a word range: not a contract). */
function apply(text: string, item: CompletionItem): string {
  expect(item.textEdit, `completion item ${JSON.stringify(item.label)} has no textEdit`).toBeDefined();
  const edit = item.textEdit as { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string };
  expect(rangeProblem(text, edit.range), `completion edit range for ${item.label}`).toBeNull();
  return TextDocument.applyEdits(TextDocument.create('file:///story.tw', 'twee', 0, text), [{ range: edit.range, newText: edit.newText }]);
}

const PASSAGE_HEADERS = [
  'Target', 'Two Words', 'Hyphen-ated', 'Ünï Çode', '𝒜 Gate 🚪', "Don't Stop", 'Say "hi"', 'Back\\\\slash',
  'A\\[B\\]', 'Left|Right', 'Tab\tName', 'Price $ 100%', 'Arrow->Name', 'Rev<-Name', 'Close\\]\\]Name',
];
const NAMES_FILE = PASSAGE_HEADERS.map(h => `:: ${h}\nbody\n`).join('\n');

/** The passages that a bracket link can name, according to the runtime. */
function linkableByRuntime(names: string[]): string[] {
  return names.filter(name => {
    const text = `:: S\n[[${name}]]\n`;
    const links = tokenize(`[[${name}]]`).filter(t => t.type === 'link');
    if (links.length !== 1) return false;
    const read = runtimeBracketLink(`[[${name}]]`);
    void text;
    return links[0].type === 'link' && links[0].target === name && read?.passage === name;
  });
}

export function registerInteractiveCells(cell: CellFn, ctx: Ctx): void {
  const baseFiles = { 'base.tw': ctx.BASE, 'names.tw': NAMES_FILE, 'widgets.tw': ':: Widgets [widget]\n{widget "my-widget"}\nx\n{/widget}\n\n:: Pw [widget]\n{widget "pw" @a @b @c}\n{@a}\n{/widget}\n\n:: BW [widget]\n{widget "BlockOne"}\n<b>{@children}</b>\n{/widget}\n' };
  const declared = (sigil: '$' | '%') => {
    const part = ctx.BASE.split('\n\n').find(p => p.startsWith(sigil === '$' ? ':: StoryVariables' : ':: StoryTransients'))!;
    return parseStoryVariables(part.split('\n').slice(1).join('\n'), sigil);
  };

  // ---------------------------------------------------------------- passage names
  const allNames = splitPassages(NAMES_FILE).map(p => p.name);
  const workspaceNames = Object.values({ ...baseFiles, 'story.tw': ':: Start\n' }).flatMap(t => splitPassages(t).map(p => p.name));
  const everyLinkable = [...new Set(linkableByRuntime(workspaceNames))].sort();
  void allNames;
  const prefixes: Array<[string, string]> = [
    ['plain', '[['], ['after-pipe', '[[go|'], ['after-arrow', '[[go->'], ['partial', '[[Tw'], ['partial-after-space', '[[x|Two W'],
    ['existing-tail', '[[Tar§get]]'], ['with-close', '[[§]]'],
  ];
  const boundaries: Array<[string, (s: string) => string]> = [
    ['lf', s => `:: Start\n${s}`], ['crlf', s => `:: Start\r\n${s}`], ['astral-prefix', s => `:: Start\n😀𝒜 ${s}`], ['next-line-text', s => `:: Start\n${s}\nmore text`],
  ];
  for (const [bname, wrap] of boundaries) {
    for (const [pname, prefix] of prefixes) {
      const marked = prefix.includes(CURSOR) ? prefix : prefix + CURSOR;
      cell(`I/completion/passage-names/${bname}/${pname}`, { role: 'ordinary', context: 'bracket target/label', spelling: 'all passage-name spellings', boundary: bname, state: 'multi-file', consumer: 'completion applied, re-read by the runtime' }, () => {
        const { items, text } = complete(baseFiles, wrap(marked));
        const labels = items.map(i => i.label).sort();
        expect(labels, 'offered passages vs the passages the runtime can link to').toEqual(everyLinkable);
        for (const item of items) {
          let result = apply(text, item);
          // close the link right after the inserted name, unless the text already does
          const edit = item.textEdit as { range: { start: { line: number; character: number } }; newText: string };
          const endOfInsert = doc(text).offsetAt(edit.range.start) + edit.newText.length;
          const restOfLine = result.slice(endOfInsert).split('\n')[0];
          if (!restOfLine.includes(']]')) result = result.slice(0, endOfInsert) + ']]' + result.slice(endOfInsert);
          const refs = runtimePassageRefs(result);
          const last = refs[refs.length - 1];
          expect(last, `no link after applying ${JSON.stringify(item.label)} to ${JSON.stringify(text)}: ${JSON.stringify(result)}`).toBeDefined();
          expect(last.target, `applying ${JSON.stringify(item.label)} to ${JSON.stringify(text)} gives ${JSON.stringify(result)}`).toBe(item.label);
          expect(last.reads, 'the runtime click goes to the chosen passage').toBe(item.label);
          // text before the completion is untouched
          expect(result.startsWith(text.slice(0, text.lastIndexOf('[[') + 2)) || /(\||->|<-)/.test(text)).toBe(true);
        }
      });
    }
  }

  // ---------------------------------------------------------------- macro names
  for (const [bname, wrap] of boundaries) {
    for (const [pname, typed] of [['bare', ''], ['prefix', 'wi'], ['hyphen-prefix', 'my-wi'], ['mixed-case', 'Block'], ['after-text', '']] as const) {
      cell(`I/completion/macro-names/${bname}/${pname}`, { role: 'ordinary', context: 'macro head', spelling: 'hyphenated and mixed-case widget names', boundary: bname, state: 'multi-file', consumer: 'completion applied, re-read by the runtime' }, () => {
        const lead = pname === 'after-text' ? 'text {if $v}' : '';
        const { items, text } = complete(baseFiles, wrap(`${lead}{${typed}${CURSOR}`));
        expect(items.length, 'macro completions offered').toBeGreaterThan(0);
        const labels = new Set(items.map(i => i.label));
        for (const w of ['my-widget', 'pw', 'BlockOne', 'set', 'if']) expect(labels.has(w), `${w} offered`).toBe(true);
        for (const item of items) {
          const result = apply(text, item) + '}';
          const heads = tokenize(result.slice(result.indexOf('\n') + 1)).filter(t => t.type === 'macro');
          const head = heads[heads.length - 1];
          expect(head, `no macro after applying ${item.label}: ${JSON.stringify(result)}`).toBeDefined();
          expect(head.type === 'macro' && head.name, `applying ${item.label} to ${JSON.stringify(text)}`).toBe(item.label);
          expect(result.includes('{{') || /\{[\w-]+\{/.test(result), `duplicated brace: ${JSON.stringify(result)}`).toBe(false);
        }
      });
    }
  }

  // ---------------------------------------------------------------- closing tags
  for (const [bname, wrap] of boundaries) {
    cell(`I/completion/closing-tag/${bname}`, { role: 'ordinary', context: 'macro head', spelling: 'block macros and block widgets', boundary: bname, state: 'multi-file', consumer: 'completion applied, buildAST pairs it' }, () => {
      const { items, text } = complete(baseFiles, wrap(`{if $v}{BlockOne}x{/${CURSOR}`));
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        const result = apply(text, item);
        const body = result.slice(result.indexOf('\n') + 1);
        const heads = tokenize(body).filter(t => t.type === 'macro');
        const closer = heads[heads.length - 1];
        expect(closer.type === 'macro' && closer.isClose && closer.name, `closer after applying ${item.label}`).toBe(String(item.label).replace(/^\{\/|\}$/g, ''));
        expect(body.endsWith('}}')).toBe(false);
      }
      // the first offered closer is the innermost open container
      expect(items[0].label).toBe('{/BlockOne}');
      registerBlockMacro('blockone');
      try {
        expect(() => buildAST(tokenize(apply(text, items[0]).split('\n').slice(1).join('\n') + '{/if}'))).not.toThrow();
      } finally { unregisterBlockMacro('blockone'); }
    });
  }

  // ---------------------------------------------------------------- variables
  const decls = declared('$');
  const trans = declared('%');
  for (const [bname, wrap] of boundaries) {
    for (const [pname, typed, sigil] of [['story', '$', '$'], ['story-partial', '$s', '$'], ['in-macro', '{set $', '$'], ['transient', '%', '%']] as const) {
      cell(`I/completion/variables/${bname}/${pname}`, { role: 'ordinary', context: 'variable/property path', spelling: 'sigils', boundary: bname, state: 'multi-file', consumer: 'completion applied, runtime-parsed declarations' }, () => {
        const { items, text, offset } = complete(baseFiles, wrap(`${typed}${CURSOR}`));
        const want = [...(sigil === '$' ? decls : trans).keys()].map(n => `${sigil}${n}`).sort();
        expect(items.map(i => i.label).sort(), 'offered variables vs the declarations the runtime parses').toEqual(want);
        for (const item of items) {
          const result = apply(text, item);
          const after = text.slice(offset);
          expect(result.endsWith(after) && result.slice(0, result.length - after.length).endsWith(String(item.label)), `applying ${item.label} to ${JSON.stringify(text)} gives ${JSON.stringify(result)}`).toBe(true);
        }
      });
    }
    cell(`I/completion/variables/${bname}/property-path`, { role: 'ordinary', context: 'variable/property path', spelling: 'dotted property', boundary: bname, state: 'multi-file', consumer: 'completion applied, runtime-parsed object fields' }, () => {
      const { items, text, offset } = complete(baseFiles, wrap(`$o.${CURSOR}`));
      const fields = Object.keys(decls.get('o')!.fields ?? {}).sort();
      expect(items.map(i => i.label).sort()).toEqual(fields);
      const endsWithAt = (result: string, source: string, cursorAt: number, want: string) => {
        const after = source.slice(cursorAt);
        return result.endsWith(after) && result.slice(0, result.length - after.length).endsWith(want);
      };
      for (const item of items) expect(endsWithAt(apply(text, item), text, offset, `$o.${item.label}`)).toBe(true);
      const partial = complete(baseFiles, wrap(`$o.na${CURSOR}`));
      for (const item of partial.items) expect(endsWithAt(apply(partial.text, item), partial.text, partial.offset, `$o.${item.label}`), `partial path ${item.label}`).toBe(true);
    });
  }

  // ---------------------------------------------------------------- roles: no story syntax completions in code/data passages
  for (const [role, header] of [['script', ':: Code [script]'], ['stylesheet', ':: Style [stylesheet]'], ['StoryData', ':: StoryData'], ['StoryVariables', ':: StoryVariables'], ['StoryTransients', ':: StoryTransients']] as const) {
    for (const [pname, typed] of [['macro', '{'], ['variable', '$'], ['passage-link', '[['], ['closing', '{/']] as const) {
      cell(`I/completion/role/${role}/${pname}`, { role, context: 'macro head/variable/bracket target', spelling: 'plain', boundary: 'eof-no-newline', state: 'multi-file', consumer: 'completion' }, () => {
        const { items } = complete({ ...baseFiles, 'base.tw': ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n' }, `${header}\nvar x = 1;\n${typed}${CURSOR}`);
        expect(items.map(i => i.label)).toEqual([]);
      });
    }
  }
  cell('I/completion/role/ordinary-controls', { role: 'ordinary/widget/StoryInit/StoryInterface', context: 'macro head/variable/bracket target', spelling: 'plain', boundary: 'eof-no-newline', state: 'multi-file', consumer: 'completion (valid controls for the role cells)' }, () => {
    for (const header of [':: Start', ':: Wr [widget]', ':: StoryInit', ':: StoryInterface']) {
      for (const typed of ['{', '$', '[[']) {
        expect(complete(baseFiles, `${header}\n${typed}${CURSOR}`).items.length, `${header} ${typed}`).toBeGreaterThan(0);
      }
    }
  });
  cell('I/completion/attribute-value', { role: 'ordinary', context: 'HTML attribute', spelling: 'plain', boundary: 'eof-no-newline', state: 'multi-file', consumer: 'completion' }, () => {
    for (const typed of ['{', '{/', '[[']) {
      expect(complete(baseFiles, `:: Start\n<a title="${typed}${CURSOR}${typed === '[[' ? '' : '}'}">x</a>`).items.map(i => i.label), `attribute ${typed}`).toEqual([]);
    }
  });

  // ---------------------------------------------------------------- signature help
  const sigBoundaries: Array<[string, (s: string) => string]> = [
    ['lf', s => `:: Start\n${s}\n`], ['crlf', s => `:: Start\r\n${s}\r\n`], ['astral-prefix', s => `:: Start\n😀𝒜 ${s}\n`], ['eof-no-newline', s => `:: Start\n${s}`],
  ];
  const sigCases: Array<[string, string, number]> = [
    ['widget-first', '{pw §}', 0], ['widget-second', '{pw 1 §}', 1], ['widget-third', '{pw 1 2 §}', 2], ['widget-quoted-space', '{pw "a b" §}', 1],
    ['widget-after-braced', '{pw {$v} §}', 1],
  ];
  for (const [bname, wrap] of sigBoundaries) {
    for (const [cname, snippet, active] of sigCases) {
      cell(`I/signature/${bname}/${cname}`, { role: 'ordinary', context: 'macro arg', spelling: 'widget with @sigil params', boundary: bname, state: 'multi-file', consumer: 'signature help' }, () => {
        const cursor = at(wrap(snippet));
        const model = build({ ...baseFiles, 'story.tw': cursor.text });
        const help = getSignatureHelp('file:///story.tw', doc(cursor.text).positionAt(cursor.offset), model);
        expect(help, 'signature help').not.toBeNull();
        expect(help!.signatures[help!.activeSignature].label).toContain('{pw ');
        expect(help!.activeParameter, 'active parameter is the argument being typed').toBe(active);
        // oracle: the runtime sees this head as a macro named pw (once closed)
        const closed = cursor.text.slice(0, cursor.offset) + cursor.text.slice(cursor.offset);
        const heads = runtimeTokens(closed).filter(t => t.token.type === 'macro' && t.token.name === 'pw');
        expect(heads.length).toBe(1);
      });
    }
  }
  for (const [role, header] of [['script', ':: Code [script]'], ['stylesheet', ':: Style [stylesheet]'], ['StoryData', ':: StoryData'], ['StoryVariables', ':: StoryVariables']] as const) {
    cell(`I/signature/role/${role}`, { role, context: 'macro arg', spelling: 'plain', boundary: 'eof-no-newline', state: 'multi-file', consumer: 'signature help' }, () => {
      const cursor = at(`${header}\n{pw 1 ${CURSOR}`);
      const model = build({ ...baseFiles, 'story.tw': cursor.text });
      expect(getSignatureHelp('file:///story.tw', doc(cursor.text).positionAt(cursor.offset), model)).toBeNull();
    });
  }
  cell('I/signature/attribute-value', { role: 'ordinary', context: 'HTML attribute', spelling: 'plain', boundary: 'eof-no-newline', state: 'multi-file', consumer: 'signature help' }, () => {
    const cursor = at(`:: Start\n<p title="{pw 1 ${CURSOR}}">x</p>`);
    const model = build({ ...baseFiles, 'story.tw': cursor.text });
    expect(getSignatureHelp('file:///story.tw', doc(cursor.text).positionAt(cursor.offset), model), 'macro in an attribute value is output as text').toBeNull();
  });
  cell('I/signature/runtime-agreement', { role: 'ordinary', context: 'macro arg', spelling: 'all', boundary: 'eof-newline', state: 'multi-file', consumer: 'signature help vs runtime macro tokens' }, () => {
    const story = ':: Start\n{pw 1 2 3} {set $v = 1} {if $v}x{/if} text {pw "a b"} <p title="{pw 1}">y</p> [[go|Target]]\n';
    const model = build({ ...baseFiles, 'story.tw': story });
    const tokens = runtimeTokens(story).filter(t => t.token.type === 'macro');
    let sawHelp = false;
    for (const offset of cursorOffsets(story)) {
      const help = getSignatureHelp('file:///story.tw', doc(story).positionAt(offset), model);
      if (!help) continue;
      sawHelp = true;
      const inside = tokens.find(t => offset > t.start && offset < t.end);
      expect(inside, `signature help at offset ${offset} (${JSON.stringify(story.slice(Math.max(0, offset - 6), offset + 6))}) is outside every runtime macro token`).toBeDefined();
      const name = inside!.token.type === 'macro' ? inside!.token.name : '';
      expect(help.signatures[0].label.startsWith(`{${name}`)).toBe(true);
    }
    expect(sawHelp).toBe(true);
  });

  cell('I/completion/role/headerless-text', { role: 'none (text before any header)', context: 'macro head/variable/bracket target', spelling: 'plain', boundary: 'empty document / no header', state: 'single-file', consumer: 'completion (still offered: the user is typing a new file)' }, () => {
    for (const typed of ['{', '$', '[[']) {
      const { items } = complete({ 'base.tw': ctx.BASE, 'names.tw': NAMES_FILE }, `${typed}${CURSOR}`);
      expect(items.length, `headerless ${typed}`).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------- entrypoints
  registerEntrypointCells(cell, ctx);
  void notApplicable; void root;
}

// ===========================================================================
// CLI and LSP entrypoints
// ===========================================================================

interface Project { dir: string; files: Record<string, string> }
const projects: string[] = [];
function writeProject(files: Files): Project {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-cross-'));
  projects.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return { dir, files };
}

const norm = (d: { range: unknown; message: string; code?: unknown; severity?: unknown }) => JSON.stringify([d.code, d.range, d.message]);

function registerEntrypointCells(cell: CellFn, ctx: Ctx): void {
  // The executable is built once for the whole run (global-setup.ts)
  const dist = { get executable() { return inject('reviewExecutable'); } };
  afterAll(() => { for (const d of projects.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const scenes: Array<[string, string, Files]> = [
    ['multi-file-refs', 'lf', ctx.files(':: Start\n[[Target]] {goto "Target"} {link "go" "Missing"}x{/link}\n{set $v = 1}{$undeclared}{wid}\n')],
    ['crlf-astral', 'crlf', ctx.files(':: Start\r\n😀𝒜 [[Target]] {set $v = 1}\r\n{nosuch}\r\n')],
    ['storyinit-widget', 'eof-no-newline', ctx.files(':: StoryInit\n{set $v = 2}\n\n:: Start\n{wid} [[Target]] <p title="{wid}">x</p>')],
    ['incomplete-multiline', 'incomplete', ctx.files(':: Start\n{if $v}\n  [[Target]]\n  {goto "Tar\n[[Unfinished')],
    ['script-stylesheet', 'lf', ctx.files(':: Code [script]\n[[Target]] {goto "Missing"}\n\n:: Style [stylesheet]\n.a { content: "{nosuch}"; }\n\n:: Start\n[[Target]]\n')],
  ];
  const abs = (dir: string, files: Files) => Object.keys(files).map(n => join(dir, n));

  for (const [sname, boundary, files] of scenes) {
    const dims = (consumer: string): Dims => ({ role: 'mixed', context: 'diagnostics and navigation', spelling: 'plain', boundary, state: 'multi-file', consumer });

    cell(`I/entry-cli/${sname}`, dims('CLI check vs in-process diagnostics'), () => {
      const project = writeProject(files);
      const run = spawnSync(process.execPath, [dist.executable, 'check', '--format', 'json', ...Object.keys(files).filter(n => /\.tw$/.test(n))], { cwd: project.dir, encoding: 'utf8' });
      const out = JSON.parse(run.stdout) as { files: Array<{ uri: string; diagnostics: Array<{ range: unknown; message: string; code: string; severity: string }> }> };
      const uris = new Map<string, string>(Object.keys(files).map(n => [pathToFileURL(join(project.dir, n)).toString(), n]));
      const model = new WorkspaceModel({ workspaceRoot: project.dir });
      model.initialize(new Map([...uris].map(([uri, n]) => [uri, files[n]] as [string, string])));
      let errors = false;
      for (const [uri, n] of uris) {
        if (!/\.tw$/.test(n)) continue;
        const want = computeDiagnostics(uri, model);
        const got = out.files.find(f => f.uri === uri)?.diagnostics ?? [];
        expect(got.map(norm).sort(), `CLI diagnostics for ${n}`).toEqual(want.map(norm).sort());
        if (want.some(d => d.severity === 'error')) errors = true;
      }
      model.dispose();
      expect(run.status, 'exit code is 1 exactly when an error is reported').toBe(errors ? 1 : 0);
    });

    cell(`I/entry-lsp/${sname}`, dims('LSP over framed JSON-RPC vs in-process consumers'), async () => {
      const project = writeProject(files);
      const proc = spawn(process.execPath, [dist.executable, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
      proc.stderr.resume();
      const conn: MessageConnection = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
      const published = new Map<string, Array<{ range: unknown; message: string; code: string }>>();
      conn.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: Array<{ range: unknown; message: string; code: string }> }) => { published.set(p.uri, p.diagnostics); });
      conn.onRequest(() => null);
      conn.listen();
      try {
        await conn.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(project.dir).toString(), capabilities: {} });
        await conn.sendNotification('initialized', {});
        const uris = new Map<string, string>(Object.keys(files).map(n => [pathToFileURL(join(project.dir, n)).toString(), n]));
        for (const [uri, n] of uris) {
          await conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'twee', version: 1, text: files[n] } });
        }
        const model = new WorkspaceModel({ workspaceRoot: project.dir });
        model.initialize(new Map([...uris].map(([uri, n]) => [uri, files[n]] as [string, string])));
        // Diagnostics: wait for the published sets to settle on the expected ones
        const wantDiag = (uri: string) => computeDiagnostics(uri, model).map(norm).sort();
        const deadline = Date.now() + 8000;
        const settled = () => [...uris.keys()].every(uri => JSON.stringify((published.get(uri) ?? []).map(norm).sort()) === JSON.stringify(wantDiag(uri)));
        while (!settled() && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
        for (const uri of uris.keys()) expect((published.get(uri) ?? []).map(norm).sort(), `published diagnostics for ${uris.get(uri)}`).toEqual(wantDiag(uri));

        for (const [uri, n] of uris) {
          if (!/\.tw$/.test(n)) continue;
          const text = files[n];
          const textDoc = doc(text);
          // links and lenses
          const links = await conn.sendRequest('textDocument/documentLink', { textDocument: { uri } }) as Array<{ range: unknown; target?: string }>;
          expect(links.map(l => JSON.stringify(l.range)), `documentLink ranges for ${n}`).toEqual(computeDocumentLinks(uri, model).map(l => JSON.stringify(l.range)));
          const lenses = await conn.sendRequest('textDocument/codeLens', { textDocument: { uri } }) as Array<{ range: unknown; command?: { title: string } }>;
          expect(lenses.map(l => [JSON.stringify(l.range), l.command?.title]), `codeLens for ${n}`).toEqual(computeCodeLenses(uri, model).map(l => [JSON.stringify(l.range), l.command.title]));
          // navigation at every cursor offset that any consumer cares about
          for (const offset of cursorOffsets(text)) {
            const pos = textDoc.positionAt(offset);
            const wantRefs = findReferences(uri, pos, model, true);
            const wantDef = getDefinition(uri, pos, model);
            const wantPrep = prepareRename(uri, pos, model);
            if (!wantRefs.length && !wantDef && !wantPrep && offset % 7 !== 0) continue;
            const refs = await conn.sendRequest('textDocument/references', { textDocument: { uri }, position: pos, context: { includeDeclaration: true } }) as Array<{ uri: string; range: unknown }> | null;
            expect((refs ?? []).map(r => JSON.stringify([r.uri, r.range])).sort(), `references at ${n}:${pos.line}:${pos.character}`).toEqual(wantRefs.map(r => JSON.stringify([r.uri, r.range])).sort());
            const def = await conn.sendRequest('textDocument/definition', { textDocument: { uri }, position: pos }) as { uri: string; range: unknown } | Array<{ uri: string; range: unknown }> | null;
            const defs = def === null ? [] : Array.isArray(def) ? def : [def];
            expect(defs.map(d => JSON.stringify([d.uri, d.range])), `definition at ${n}:${pos.line}:${pos.character}`).toEqual(wantDef ? [JSON.stringify([wantDef.uri, wantDef.range])] : []);
            const prep = await conn.sendRequest('textDocument/prepareRename', { textDocument: { uri }, position: pos }) as { range: unknown; placeholder: string } | null;
            expect(prep === null ? null : JSON.stringify(prep.range), `prepareRename at ${n}:${pos.line}:${pos.character}`).toEqual(wantPrep ? JSON.stringify(wantPrep.range) : null);
            if (wantPrep && offset % 5 === 0) {
              const newName = /^[$%]/.test(text.slice(textDoc.offsetAt(wantPrep.range.start), textDoc.offsetAt(wantPrep.range.start) + 1)) ? 'renamedVar' : 'Renamed Name';
              const edit = await conn.sendRequest('textDocument/rename', { textDocument: { uri }, position: pos, newName }).catch(() => null) as { changes?: Record<string, Array<{ range: unknown; newText: string }>> } | null;
              let wantEdit: Map<string, Array<{ range: unknown; newText: string }>> | null = null;
              try { wantEdit = computeRename(uri, pos, newName, model); } catch { wantEdit = null; }
              if (wantEdit && wantEdit.size > 0) {
                expect(edit?.changes, `rename at ${n}:${pos.line}:${pos.character}`).toBeDefined();
                const flat = (m: Iterable<[string, Array<{ range: unknown; newText: string }>]>) => [...m].flatMap(([u, es]) => es.map(e => JSON.stringify([u, e.range, e.newText]))).sort();
                expect(flat(Object.entries(edit!.changes!))).toEqual(flat(wantEdit));
              }
            }
          }
        }
        model.dispose();
      } finally {
        try { await conn.sendRequest('shutdown'); await conn.sendNotification('exit'); } catch { /* gone */ }
        conn.dispose();
        proc.kill();
      }
    });
  }
  // ------------------------------------------------------------ byte order mark and formatting through the CLI
  cell('I/entry-cli/bom-check-and-format', { role: 'ordinary', context: 'prose', spelling: 'plain', boundary: 'bom-first-header', state: 'multi-file', consumer: 'CLI check and format' }, () => {
    const story = ':: Start  \n[[Missing]]   \n{set $undeclared = 1}\n';
    const withBom = writeProject({ 'story.tw': '\uFEFF' + story });
    const without = writeProject({ 'story.tw': story });
    const check = (dir: string) => JSON.parse(spawnSync(process.execPath, [dist.executable, 'check', '--format', 'json', 'story.tw'], { cwd: dir, encoding: 'utf8' }).stdout).files[0].diagnostics.map(norm).sort() as string[];
    expect(check(withBom.dir), 'a leading BOM changes nothing the checker reports').toEqual(check(without.dir));
    expect(check(without.dir).length).toBeGreaterThan(0);
    const run = (args: string[], dir: string) => spawnSync(process.execPath, [dist.executable, 'format', ...args], { cwd: dir, encoding: 'utf8' });
    expect(run(['story.tw'], withBom.dir).status).toBe(0);
    const bytes = readFileSync(join(withBom.dir, 'story.tw'));
    expect([...bytes.subarray(0, 3)], 'format keeps the byte order mark').toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString('utf8')).toBe(':: Start\n[[Missing]]  \n{set $undeclared = 1}\n');
    expect(run(['--check', 'story.tw'], withBom.dir).status, 'formatted file is stable').toBe(0);
  });

  // ------------------------------------------------------------ LSP state: unsaved edit, close, reopen
  cell('I/entry-lsp-state/edit-close-reopen', { role: 'ordinary', context: 'bracket target', spelling: 'plain', boundary: 'eof-newline', state: 'unsaved edit / close / reopen over JSON-RPC', consumer: 'LSP diagnostics vs in-process workspace' }, async () => {
    const files = { 'story.tw': ':: Start\n[[Target]]\n', 'target.tw': ':: Target\nthere\n' };
    const project = writeProject(files);
    const proc = spawn(process.execPath, [dist.executable, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stderr.resume();
    const conn: MessageConnection = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
    const published = new Map<string, Array<{ range: unknown; message: string; code: string }>>();
    conn.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: Array<{ range: unknown; message: string; code: string }> }) => { published.set(p.uri, p.diagnostics); });
    conn.onRequest(() => null);
    conn.listen();
    const storyUri = pathToFileURL(join(project.dir, 'story.tw')).toString();
    const targetUri = pathToFileURL(join(project.dir, 'target.tw')).toString();
    const model = new WorkspaceModel({ workspaceRoot: project.dir });
    model.initialize(new Map([[storyUri, files['story.tw']], [targetUri, files['target.tw']]]));
    const settle = async (label: string) => {
      const want = computeDiagnostics(storyUri, model).map(norm).sort();
      const deadline = Date.now() + 8000;
      while (JSON.stringify((published.get(storyUri) ?? []).map(norm).sort()) !== JSON.stringify(want) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
      expect((published.get(storyUri) ?? []).map(norm).sort(), label).toEqual(want);
    };
    try {
      await conn.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(project.dir).toString(), capabilities: {} });
      await conn.sendNotification('initialized', {});
      await conn.sendNotification('textDocument/didOpen', { textDocument: { uri: storyUri, languageId: 'twee', version: 1, text: files['story.tw'] } });
      await settle('opened with the target on disk');
      // unsaved edit: the story now links to a passage that does not exist
      const edited = ':: Start\n[[Target]] [[Gone]] {set $undeclared = 1}\n';
      await conn.sendNotification('textDocument/didChange', { textDocument: { uri: storyUri, version: 2 }, contentChanges: [{ text: edited }] });
      model.documents.update(storyUri, edited);
      await settle('after an unsaved edit');
      // an unsaved edit of the target removes the passage; the editor buffer wins over the disk
      await conn.sendNotification('textDocument/didOpen', { textDocument: { uri: targetUri, languageId: 'twee', version: 1, text: ':: Renamed\nthere\n' } });
      model.documents.update(targetUri, ':: Renamed\nthere\n');
      await settle('after the target buffer renamed its passage');
      // closing the buffer falls back to the file on disk
      await conn.sendNotification('textDocument/didClose', { textDocument: { uri: targetUri } });
      model.documents.update(targetUri, files['target.tw']);
      await settle('after closing the target buffer');
      model.dispose();
    } finally {
      try { await conn.sendRequest('shutdown'); await conn.sendNotification('exit'); } catch { /* gone */ }
      conn.dispose();
      proc.kill();
    }
  });
  void abs; void symlinkSync;
}
