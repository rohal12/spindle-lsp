/**
 * Review contract corpus. These assertions describe desired behavior, rather
 * than blessing known failures. See docs/reviews/process.md for triage/closure.
 * Runtime evaluation below is restricted to literals constructed by these tests.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { tokenize } from '../../node_modules/@rohal12/spindle/src/markup/tokenizer.js';
import { parseStoryVariables } from '../../node_modules/@rohal12/spindle/src/story-variables.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import type { Range } from '../../src/core/types.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeRename } from '../../src/plugins/rename.js';
import { findPassageReferences, findVariableReferences, findWidgetReferences } from '../../src/plugins/references.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { computeDocumentLinks } from '../../src/plugins/document-link.js';
import { computeCodeLenses } from '../../src/plugins/code-lens.js';
import { computeCodeActions } from '../../src/plugins/code-actions.js';
import { getCompletions } from '../../src/plugins/completions.js';
import { getSignatureHelp } from '../../src/plugins/signature.js';
import { computeSemanticTokensAbsolute } from '../../src/plugins/semantic-tokens.js';
import { formatDocument } from '../../src/plugins/format.js';

const uri = 'file:///story.tw';
const models: WorkspaceModel[] = [];
function workspace(text: string, extra: Array<[string, string]> = []) {
  const model = new WorkspaceModel({ workspaceRoot: process.cwd() });
  model.initialize(new Map([...extra, [uri, text]]));
  models.push(model);
  return model;
}
afterEach(() => { for (const model of models.splice(0)) model.dispose(); });

function apply(text: string, edits: Array<{ range: Range; newText: string }>) {
  return TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, text), edits);
}
function renamed(model: WorkspaceModel, line: number, character: number, name: string) {
  const edits = computeRename(uri, { line, character }, name, model);
  return apply(model.documents.getText(uri)!, edits.get(uri) ?? []);
}
function codes(model: WorkspaceModel) {
  return computeDiagnostics(uri, model).map(d => d.code);
}
function runtimeMacroArgs(text: string) {
  return tokenize(text).filter(t => t.type === 'macro').map(t => t.rawArgs);
}

describe('F66: formatting preserves runtime macro payloads (#66)', () => {
  for (const newline of ['\n', '\r\n']) {
    it(`F66-${newline.length}: multiline template in HTML`, async () => {
      const body = '<div>\n<span>{print `a\nb`}</span>\n</div>'.replaceAll('\n', newline);
      const text = `:: StoryVariables${newline}:: Start${newline}${body}`;
      const output = await formatDocument(text);
      expect(runtimeMacroArgs(output)).toEqual(runtimeMacroArgs(text.replaceAll('\r\n', '\n')));
      expect(await formatDocument(output)).toBe(output);
    });
  }
  it('C-F66: single-line HTML macro remains intact and idempotent', async () => {
    const text = ':: StoryVariables\n:: Start\n<div><span>{print "a b"}</span></div>';
    const output = await formatDocument(text);
    expect(runtimeMacroArgs(output)).toEqual(runtimeMacroArgs(text));
    expect(await formatDocument(output)).toBe(output);
  });
});

describe('R67: rename preserves literal meaning (#67)', () => {
  for (const [id, macro, delimiter, name] of [
    ['double', 'goto', '"', 'Bob"s'],
    ['single', 'goto', "'", "Bob's"],
    ['slash', 'include', '"', 'A\\B'],
    ['template', 'goto', '`', 'A`B'],
  ]) {
    it(`R67-${id}: ${macro} literal`, () => {
      const model = workspace(`:: StoryVariables\n:: Old\nhello\n:: Start\n{${macro} ${delimiter}Old${delimiter}}`);
      const output = renamed(model, 1, 5, name);
      const args = runtimeMacroArgs(output).at(-1)!;
      // This is a fixed benign fixture, never document/project code.
      expect(new Function(`return (${args})`)()).toBe(name);
    });
  }
  it('C-R67: ordinary header and bracket link rename agree', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n[[Old]]');
    const output = renamed(model, 1, 5, 'New');
    expect(output).toContain(':: New\n');
    expect(tokenize(output).filter(t => t.type === 'link').map(t => t.target)).toEqual(['New']);
  });
});

it('Q68: create StoryVariables in a story file, preserving opened config (#68)', () => {
  const configUri = 'file:///spindle.config.yaml';
  const config = 'macros: {}\n';
  const model = workspace(':: Start\n{$missing}', [[configUri, config]]);
  const diag = computeDiagnostics(uri, model).filter(d => d.code === 'SP202');
  expect(diag).toHaveLength(1);
  const action = computeCodeActions(uri, diag, model)[0];
  expect(action).toBeDefined();
  expect(action.edits.every(e => e.uri === uri)).toBe(true);
  expect(model.documents.getText(configUri)).toBe(config);
  const output = apply(model.documents.getText(uri)!, action.edits);
  expect(workspace(output).variables.hasStoryVariables()).toBe(true);
});

describe('Q69: declaration edit application (#69)', () => {
  for (const sigil of ['$', '%'] as const) {
    for (const ending of ['value', 'header', 'newline']) {
      it(`Q69-${sigil}-${ending}: parse the edited declaration passage`, () => {
        const passage = sigil === '$' ? 'StoryVariables' : 'StoryTransients';
        const declUri = 'file:///declarations.tw';
        const text = `:: ${passage}` + (ending === 'header' ? '' : `\n${sigil}x = 1` + (ending === 'newline' ? '\n' : ''));
        const model = workspace(`:: Start\n{${sigil}missing}`, [[declUri, text]]);
        const code = sigil === '$' ? 'SP200' : 'SP203';
        const diagnostics = computeDiagnostics(uri, model).filter(d => d.code === code);
        expect(diagnostics).toHaveLength(1);
        const action = computeCodeActions(uri, diagnostics, model)[0];
        expect(action).toBeDefined();
        const output = apply(text, action.edits.filter(e => e.uri === declUri));
        expect(output.split('\n')[0]).toBe(`:: ${passage}`);
        const schema = parseStoryVariables(output.slice(output.indexOf('\n') + 1), sigil);
        expect(schema.get('missing')?.default).toBe(0);
        if (ending !== 'header') expect(schema.get('x')?.default).toBe(1);
      });
    }
  }
});

describe('X70: passage references honor source context (#70)', () => {
  for (const [id, body] of [
    ['macro-string', '{print "[[Old]]"}'],
    ['attribute', '<div title="[[Old]]">x</div>'],
    ['script', ':: Code [script]\nconst docs = "[[Old]]";'],
    ['stylesheet', ':: CSS [stylesheet]\na::after { content: "[[Old]]"; }'],
  ]) {
    for (const feature of ['references', 'rename', 'definition', 'document-links', 'code-lenses', 'diagnostics']) {
      it(`X70-${id}-${feature}: literal context`, () => {
        if (id === 'macro-string' || id === 'attribute') {
          expect(tokenize(body).filter(t => t.type === 'link')).toHaveLength(0);
        }
        const text = `:: StoryVariables\n:: Old\nhello\n:: Start\n${body}`;
        const model = workspace(text);
        if (feature === 'references') expect(findPassageReferences('Old', model, false)).toHaveLength(0);
        if (feature === 'rename') expect(renamed(model, 1, 5, 'New')).toContain(body);
        if (feature === 'definition') {
          const position = TextDocument.create(uri, 'twee', 0, text).positionAt(text.lastIndexOf('Old') + 1);
          expect(getDefinition(uri, position, model)).toBeNull();
        }
        if (feature === 'document-links') expect(computeDocumentLinks(uri, model)).toHaveLength(0);
        if (feature === 'code-lenses') expect(computeCodeLenses(uri, model).find(l => l.range.start.line === 1)?.command.title).toBe('0 references');
        if (feature === 'diagnostics') expect(codes(workspace(text.replace(':: Old', ':: Target')))).not.toContain('SP300');
      });
    }
  }
  it('C-X70: real links and goto literals are references', () => {
    const model = workspace(':: StoryVariables\n:: Old\nhello\n:: Start\n[[Old]] {goto "Old"}');
    expect(findPassageReferences('Old', model, false)).toHaveLength(2);
    expect(getDefinition(uri, { line: 4, character: 3 }, model)?.uri).toBe(uri);
  });
});

it('X71: macro-looking link labels remain labels (#71)', () => {
  const body = '[[{if true}label|Next]]';
  expect(tokenize(body).filter(t => t.type === 'macro')).toHaveLength(0);
  const model = workspace(`:: StoryVariables\n:: Next\nhello\n:: Start\n${body}`);
  expect(codes(model)).not.toContain('SP101');
});

describe('X72: non-markup passage bodies (#72)', () => {
  for (const passage of ['StoryVariables', 'StoryTransients', 'StoryData']) {
    it(`X72-${passage}: valid data strings receive no markup diagnostics`, () => {
      const body = passage === 'StoryData' ? '{"format":"Spindle","note":"{if true}"}' : `${passage === 'StoryTransients' ? '%' : '$'}v = "{if true}"`;
      if (passage !== 'StoryData') expect(parseStoryVariables(body, passage === 'StoryTransients' ? '%' : '$').get('v')?.default).toBe('{if true}');
      const model = workspace(`:: ${passage}\n${body}\n:: Start\nhello`);
      expect(codes(model)).not.toContain('SP101');
    });
  }
  it('C-X72: invalid declarations still receive declaration diagnostics', () => {
    expect(codes(workspace(':: StoryVariables\n$x = null\n:: Start\nhello'))).toContain('SP204');
  });
});

it('V73: cross-file StoryInterface variables participate in rename (#73)', () => {
  const declUri = 'file:///vars.tw';
  const model = workspace(':: StoryInterface\n<div>{$x}</div>\n:: Start\nhello', [[declUri, ':: StoryVariables\n$x = 1']]);
  expect(findVariableReferences('x', model, true)).toHaveLength(2);
  const edits = computeRename(declUri, { line: 1, character: 2 }, 'y', model);
  const output = apply(model.documents.getText(uri)!, edits.get(uri) ?? []);
  expect(output).toContain('{$y}');
  const next = workspace(output, [[declUri, apply(model.documents.getText(declUri)!, edits.get(declUri) ?? [])]]);
  expect(codes(next)).not.toContain('SP200');
});

describe('W74: widget spelling shared by navigation and edits (#74)', () => {
  for (const [id, name, prefix] of [['css', 'greeting', '.red '], ['hyphen', 'hello-world', '']]) {
    it(`W74-${id}: definition, references, and applied rename`, () => {
      const declUri = 'file:///widgets.tw';
      const model = workspace(`:: StoryVariables\n:: Start\n{${prefix}${name} "Alice"}`, [[declUri, `:: Widgets [widget]\n{widget "${name}" @x}\n{@x}\n{/widget}`]]);
      expect(tokenize(model.documents.getText(uri)!).filter(t => t.type === 'macro').map(t => t.name)).toContain(name);
      expect(getDefinition(uri, { line: 2, character: prefix.length + 2 }, model)?.uri).toBe(declUri);
      expect(findWidgetReferences(name, model, false)).toHaveLength(1);
      const edits = computeRename(declUri, { line: 1, character: 11 }, 'renamed', model);
      expect(apply(model.documents.getText(uri)!, edits.get(uri) ?? [])).toContain(`{${prefix}renamed "Alice"}`);
    });
  }
});

it('E75: apply closing macro completion at the typed cursor (#75)', () => {
  const model = workspace(':: StoryVariables\n:: Start\n{if true}\n{/');
  const position = { line: 3, character: 2 };
  const item = getCompletions(uri, position, '/', model).find(c => c.label === '{/if}');
  expect(item).toBeDefined();
  const edit = item!.textEdit ?? { range: { start: position, end: position }, newText: item!.insertText ?? item!.label };
  expect('range' in edit).toBe(true);
  const output = apply(model.documents.getText(uri)!, [edit as { range: Range; newText: string }]);
  expect(output.split('\n').at(-1)).toBe('{/if}');
  expect(codes(workspace(output))).not.toContain('SP101');
});

describe('L77: decode static JavaScript literals (#77)', () => {
  for (const [id, spelling] of [['unicode', '\\u004eext'], ['hex', '\\x4eext']]) {
    for (const macro of ['goto', 'include']) {
      it(`L77-${id}-${macro}: decoded target has a definition and rename`, () => {
        expect(new Function(`return ("${spelling}")`)()).toBe('Next');
        const model = workspace(`:: StoryVariables\n:: Next\nhello\n:: Start\n{${macro} "${spelling}"}`);
        expect(findPassageReferences('Next', model, false)).toHaveLength(1);
        expect(getDefinition(uri, { line: 4, character: macro.length + 4 }, model)?.uri).toBe(uri);
        const output = renamed(model, 1, 5, 'Other');
        expect(new Function(`return (${runtimeMacroArgs(output).at(-1)})`)()).toBe('Other');
      });
    }
  }
});

it('D78: explicit Spindle stories require StoryVariables without variable usages (#78)', () => {
  const model = workspace(':: StoryData\n{"format":"Spindle"}\n:: Start\nhello');
  expect(codes(model)).toContain('SP202');
});
it('C-D78: an empty StoryVariables passage satisfies that startup requirement', () => {
  expect(codes(workspace(':: StoryData\n{"format":"Spindle"}\n:: StoryVariables\n:: Start\nhello'))).not.toContain('SP202');
});

describe('H79: signature schema and active argument (#79)', () => {
  for (const [macro, args, active] of [['textbox', '$name ', 1], ['radiobutton', '$name "yes" ', 2]]) {
    it(`H79-${macro}: schema describes each active argument`, () => {
      const body = `{${macro} ${args}`;
      const model = workspace(`:: StoryVariables\n$name = ""\n:: Start\n${body}`);
      const help = getSignatureHelp(uri, { line: 3, character: body.length }, model);
      expect(help).not.toBeNull();
      expect(help!.activeParameter).toBe(active);
      expect(help!.signatures[help!.activeSignature].parameters.length).toBeGreaterThan(active);
    });
  }
  it('H79-partial: typing the first receiver keeps parameter zero active', () => {
    const model = workspace(':: StoryVariables\n:: Start\n{textbox $na');
    expect(getSignatureHelp(uri, { line: 2, character: 12 }, model)?.activeParameter).toBe(0);
  });
});

it('S80: variable identifiers do not overlap keyword semantic tokens (#80)', () => {
  const tokens = computeSemanticTokensAbsolute(uri, workspace(':: StoryVariables\n$is = 1\n:: Start\n{$is}'));
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].line === tokens[i - 1].line) {
      expect(tokens[i].startChar).toBeGreaterThanOrEqual(tokens[i - 1].startChar + tokens[i - 1].length);
    }
  }
});

describe('B76: public executable transport (#76)', () => {
  interface InitializeResponse {
    id?: unknown;
    result?: { capabilities?: unknown };
  }
  let directory: string;
  let executable: string;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'spindle-review-bin-'));
    executable = join(directory, 'bin.mjs');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    await build({
      entryPoints: ['src/bin.ts'], bundle: true, platform: 'node', target: 'node18', format: 'esm',
      outfile: executable, external: ['prettier'],
      define: { SPINDLE_LSP_VERSION: JSON.stringify(pkg.version) },
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    });
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  async function initialize(args: string[]): Promise<{ output: string; response?: InitializeResponse }> {
    const child = spawn(process.execPath, [executable, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let buffer = Buffer.alloc(0);
    let stderr = '';
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`initialize timeout: ${stderr}`)), 4000);
        child.on('error', reject);
        child.stdin.on('error', () => {}); // early help exit is itself the asserted defect
        child.stderr.on('data', data => { stderr += data; });
        child.stdout.on('data', data => {
          output += data;
          buffer = Buffer.concat([buffer, data]);
          for (;;) {
            const split = buffer.indexOf('\r\n\r\n');
            if (split < 0) break;
            const length = /Content-Length: (\d+)/i.exec(buffer.subarray(0, split).toString())?.[1];
            if (!length || buffer.length < split + 4 + Number(length)) break;
            const end = split + 4 + Number(length);
            const message: InitializeResponse = JSON.parse(buffer.subarray(split + 4, end).toString());
            buffer = buffer.subarray(end);
            if (message.id === 99) resolve({ output, response: message });
          }
        });
        child.on('exit', () => resolve({ output }));
        const request = JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
        child.stdin.write(`Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`);
      });
    } finally {
      clearTimeout(timer!);
      child.kill();
    }
  }
  it('B76-default: no arguments receives a JSON-RPC initialize response', async () => {
    const { output, response } = await initialize([]);
    expect(output).toMatch(/^Content-Length:/);
    expect(response?.id).toBe(99);
    expect(response?.result?.capabilities).toBeDefined();
  });
  it('C-B76: explicit --stdio receives a JSON-RPC initialize response', async () => {
    const { output, response } = await initialize(['--stdio']);
    expect(output).toMatch(/^Content-Length:/);
    expect(response?.id).toBe(99);
    expect(response?.result?.capabilities).toBeDefined();
  });
});
