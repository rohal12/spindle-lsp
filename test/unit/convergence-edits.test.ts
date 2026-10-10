/**
 * Applied-edit contracts moved from test/review/convergence.review.ts:
 * Q68 (#68), Q69 (#69), E75 (#75). Edits are applied with
 * TextDocument.applyEdits and the result is re-parsed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { tokenize } from '../helpers/tooling.js';
import { parseStoryVariables } from '../helpers/story-variables-oracle.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import type { Range } from '../../src/core/types.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeCodeActions } from '../../src/plugins/code-actions.js';
import { getCompletions } from '../../src/plugins/completions.js';
import { missingStoryVariablesOwner } from '../../src/core/workspace/story-variables-owner.js';

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
function codes(model: WorkspaceModel) {
  return computeDiagnostics(uri, model).map(d => d.code);
}

describe('Q68: create StoryVariables in a story file (#68)', () => {
  const configs: Array<[string, string]> = [
    ['file:///spindle.config.yaml', 'macros: {}\n'],
    ['file:///spindle.config.json', '{"macros":{}}\n'],
    ['file:///macros.js', 'export const x = 1;\n'],
    ['file:///macros.ts', 'export const x = 1;\n'],
  ];
  for (const [configUri, config] of configs) {
    for (const reversed of [false, true]) {
      it(`Q68: ${configUri.split('/').pop()} opened ${reversed ? 'after' : 'before'} the story`, () => {
        const model = new WorkspaceModel({ workspaceRoot: process.cwd() });
        models.push(model);
        const entries: Array<[string, string]> = [[configUri, config], [uri, ':: Start\n{$missing}']];
        model.initialize(new Map(reversed ? entries.reverse() : entries));
        const diag = computeDiagnostics(uri, model).filter(d => d.code === 'SP202');
        expect(diag).toHaveLength(1);
        const action = computeCodeActions(uri, diag, model)[0];
        expect(action).toBeDefined();
        expect(action.edits.every(e => e.uri === uri)).toBe(true);
        expect(model.documents.getText(configUri)).toBe(config);
        const output = apply(model.documents.getText(uri)!, action.edits);
        expect(workspace(output).variables.hasStoryVariables()).toBe(true);
      });
    }
  }
  it('Q68-eof: story without trailing newline keeps its last line', () => {
    const model = workspace(':: Start\n{$missing}');
    const diag = computeDiagnostics(uri, model).filter(d => d.code === 'SP202');
    const output = apply(':: Start\n{$missing}', computeCodeActions(uri, diag, model)[0].edits);
    expect(output.startsWith(':: Start\n{$missing}\n')).toBe(true);
    expect(output).toContain(':: StoryVariables');
  });
  it('Q68-safe: diagnostic outside a story and no story document yields no action', () => {
    const model = new WorkspaceModel({ workspaceRoot: process.cwd() });
    models.push(model);
    model.initialize(new Map([['file:///spindle.config.yaml', 'macros: {}\n']]));
    const fake = { code: 'SP202', message: 'x', severity: 2, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } } as never;
    expect(computeCodeActions('file:///spindle.config.yaml', [fake], model)).toEqual([]);
  });
  it('Q68-other-doc: diagnostic in another story file targets that file', () => {
    const other = 'file:///other.twee';
    const model = workspace(':: Start\n{$missing}', [[other, ':: Other\nhi\n']]);
    // SP202 is reported once (#78), on whichever story document owns it.
    const owner = [uri, other].find(u => computeDiagnostics(u, model).some(d => d.code === 'SP202'))!;
    expect(owner).toBeDefined();
    const diag = computeDiagnostics(owner, model).filter(d => d.code === 'SP202');
    const action = computeCodeActions(owner, diag, model)[0];
    expect(action.edits.length).toBeGreaterThan(0);
    expect(action.edits.every(e => e.uri === owner)).toBe(true);
  });
});

describe('Q69: declaration edit application (#69)', () => {
  for (const sigil of ['$', '%'] as const) {
    for (const ending of ['value', 'header', 'newline']) {
      for (const eol of ['\n', '\r\n']) {
        it(`Q69-${sigil}-${ending}${eol === '\n' ? '' : '-crlf'}: parse the edited declaration passage`, () => {
          const passage = sigil === '$' ? 'StoryVariables' : 'StoryTransients';
          const declUri = 'file:///declarations.tw';
          const text = `:: ${passage}` + (ending === 'header' ? '' : `${eol}${sigil}x = 1` + (ending === 'newline' ? eol : ''));
          const model = workspace(`:: Start\n{${sigil}missing}`, [[declUri, text]]);
          const code = sigil === '$' ? 'SP200' : 'SP203';
          const diagnostics = computeDiagnostics(uri, model).filter(d => d.code === code);
          expect(diagnostics).toHaveLength(1);
          const action = computeCodeActions(uri, diagnostics, model)[0];
          expect(action).toBeDefined();
          expect(action.edits.every(e => e.uri === declUri)).toBe(true);
          const output = apply(text, action.edits);
          expect(output.split(/\r?\n/)[0]).toBe(`:: ${passage}`);
          const schema = parseStoryVariables(output.slice(output.search(/\n/) + 1), sigil);
          expect(schema.get('missing')?.default).toBe(0);
          if (ending !== 'header') expect(schema.get('x')?.default).toBe(1);
          if (eol === '\r\n' && ending !== 'header') expect(output.replace(/\r\n/g, '')).not.toContain('\n');
        });
      }
    }
    it(`Q69-${sigil}-next-passage: insertion preserves the following header and declarations`, () => {
      const passage = sigil === '$' ? 'StoryVariables' : 'StoryTransients';
      const declUri = 'file:///declarations.tw';
      const text = `:: ${passage}\n${sigil}x = 1\n:: Other\nbody`;
      const model = workspace(`:: Start\n{${sigil}missing}`, [[declUri, text]]);
      const code = sigil === '$' ? 'SP200' : 'SP203';
      const action = computeCodeActions(uri, computeDiagnostics(uri, model).filter(d => d.code === code), model)[0];
      const output = apply(text, action.edits);
      expect(output).toBe(`:: ${passage}\n${sigil}x = 1\n${sigil}missing = 0\n:: Other\nbody`);
    });
  }
});

describe('E75: apply closing macro completion at the typed cursor (#75)', () => {
  function complete(text: string, position: { line: number; character: number }, label: string) {
    const model = workspace(text);
    const item = getCompletions(uri, position, '/', model).find(c => c.label === label);
    expect(item).toBeDefined();
    const edit = item!.textEdit as { range: Range; newText: string };
    expect(edit && 'range' in edit).toBe(true);
    return { output: apply(text, [edit]), item: item! };
  }

  it('E75: apply closing macro completion at the typed cursor', () => {
    const text = ':: StoryVariables\n:: Start\n{if true}\n{/';
    const { output } = complete(text, { line: 3, character: 2 }, '{/if}');
    expect(output.split('\n').at(-1)).toBe('{/if}');
    expect(codes(workspace(output))).not.toContain('SP101');
  });
  it('E75-partial: partially typed closing name', () => {
    const { output, item } = complete(':: StoryVariables\n:: Start\n{if true}\n{/i', { line: 3, character: 3 }, '{/if}');
    expect(output.split('\n').at(-1)).toBe('{/if}');
    expect(item.filterText).toBe('{/if}');
  });
  it('E75-after: existing text after the cursor is preserved, a typed tail is replaced', () => {
    const { output } = complete(':: StoryVariables\n:: Start\n{if true}\n{/} tail', { line: 3, character: 2 }, '{/if}');
    expect(output.split('\n').at(-1)).toBe('{/if} tail');
  });
  it('E75-before: characters before the prefix are preserved', () => {
    const { output } = complete(':: StoryVariables\n:: Start\n{if true}\nabc {/', { line: 3, character: 6 }, '{/if}');
    expect(output.split('\n').at(-1)).toBe('abc {/if}');
  });
  it('E75-nested: innermost container is offered and closes validly', () => {
    const text = ':: StoryVariables\n:: Start\n{if true}\n{for @x of [1]}\n{/';
    const model = workspace(text);
    const labels = getCompletions(uri, { line: 4, character: 2 }, '/', model).map(c => c.label);
    expect(labels).toEqual(['{/for}', '{/if}']);
    const { output } = complete(text, { line: 4, character: 2 }, '{/for}');
    expect(output.split('\n').at(-1)).toBe('{/for}');
  });
  it('E75-boundary: containers in an earlier passage are not offered', () => {
    const model = workspace(':: StoryVariables\n:: A\n{if true}\n:: Start\n{/');
    expect(getCompletions(uri, { line: 4, character: 2 }, '/', model)).toEqual([]);
  });
});

// Keep the tokenizer import honest: the completed output tokenizes as a close.
it('E75-runtime: completed output closes the container for the runtime tokenizer', () => {
  const model = workspace(':: StoryVariables\n:: Start\n{if true}\n{/');
  const item = getCompletions(uri, { line: 3, character: 2 }, '/', model)[0];
  const out = apply(':: StoryVariables\n:: Start\n{if true}\n{/', [item.textEdit as { range: Range; newText: string }]);
  expect(tokenize(out).filter(t => t.type === 'macro').map(t => t.name)).toEqual(['if', 'if']);
});

describe('H78: SP202 owner and quick-fix target are one document (#78)', () => {
  const data = ':: StoryData\n{"format":"Spindle"}\n';
  /** Build, find the single SP202, apply its fix to every edited document, rebuild. */
  function fixAndRebuild(entries: Array<[string, string]>, eol = '\n') {
    const model = new WorkspaceModel({ workspaceRoot: process.cwd() });
    models.push(model);
    model.initialize(new Map(entries));
    const all = entries.map(([u]) => u);
    const found = all.flatMap(u => computeDiagnostics(u, model).filter(d => d.code === 'SP202').map(d => ({ u, d })));
    expect(found).toHaveLength(1);
    const { u: owner, d } = found[0];
    // The fix must be offered from every document, and always target the owner.
    for (const u of all) {
      const edits = computeCodeActions(u, [d], model).flatMap(a => a.edits);
      expect(edits.length).toBeGreaterThan(0);
      expect(edits.every(e => e.uri === owner)).toBe(true);
    }
    const action = computeCodeActions(owner, [d], model)[0];
    const next = new Map(entries);
    for (const u of new Set(action.edits.map(e => e.uri))) {
      next.set(u, TextDocument.applyEdits(
        TextDocument.create(u, 'twee', 0, model.documents.getText(u)!),
        action.edits.filter(e => e.uri === u).map(e => ({ range: e.range, newText: e.newText })),
      ));
    }
    const rebuilt = new WorkspaceModel({ workspaceRoot: process.cwd() });
    models.push(rebuilt);
    rebuilt.initialize(next);
    for (const u of all) {
      expect(computeDiagnostics(u, rebuilt).filter(x => x.code === 'SP202')).toEqual([]);
    }
    expect(rebuilt.variables.hasStoryVariables()).toBe(true);
    if (eol === '\r\n') expect(next.get(owner)!.replace(/\r\n/g, '')).not.toContain('\n');
    return { owner, next };
  }

  it('H78-first: owner is the first story document', () => {
    const { owner } = fixAndRebuild([[uri, `${data}:: Start\nhi`], ['file:///b.tw', ':: B\nhi']]);
    expect(owner).toBe(uri);
  });
  it('H78-empty-first: first document without passages is skipped by both', () => {
    const empty = 'file:///empty.tw';
    const { owner, next } = fixAndRebuild([[empty, ''], [uri, `${data}:: Start\nhi`]]);
    expect(owner).toBe(uri);
    expect(next.get(empty)).toBe('');
  });
  it('H78-config-first: YAML/JSON/JS opened first are never targeted', () => {
    for (const [c, text] of [
      ['file:///spindle.config.yaml', 'macros: {}\n'],
      ['file:///spindle.config.json', '{}\n'],
      ['file:///m.js', 'export const x = 1;\n'],
    ] as Array<[string, string]>) {
      const { owner, next } = fixAndRebuild([[c, text], [uri, `${data}:: Start\nhi`]]);
      expect(owner).toBe(uri);
      expect(next.get(c)).toBe(text);
    }
  });
  it('H78-multi: with several story documents only the first with passages is touched', () => {
    const b = 'file:///b.tw';
    const { owner, next } = fixAndRebuild([['file:///a-empty.tw', '\n'], [uri, `${data}:: Start\nhi`], [b, ':: B\nhi\n']]);
    expect(owner).toBe(uri);
    expect(next.get(b)).toBe(':: B\nhi\n');
  });
  it('H78-unsaved: an open unsaved edit that adds passages changes owner and target together', () => {
    const empty = 'file:///empty.tw';
    const model = workspace(`${data}:: Start\nhi`, [[empty, '']]);
    model.documents.update(empty, ':: Draft\nnew');
    const all = [empty, uri];
    const owners = all.filter(u => computeDiagnostics(u, model).some(d => d.code === 'SP202'));
    expect(owners).toHaveLength(1);
    const d = computeDiagnostics(owners[0], model).find(x => x.code === 'SP202')!;
    for (const u of all) {
      expect(computeCodeActions(u, [d], model)[0].edits.every(e => e.uri === owners[0])).toBe(true);
    }
  });
  it('H78-crlf: CRLF owner keeps CRLF and the fix clears SP202', () => {
    const text = `:: StoryData\r\n{"format":"Spindle"}\r\n:: Start\r\nhi`;
    const { next, owner } = fixAndRebuild([[uri, text]], '\r\n');
    expect(next.get(owner)).toContain('\r\n:: StoryVariables\r\n');
    expect(next.get(owner)!).not.toMatch(/[^\r]\n/);
  });
});

describe('M-SP202: a declared Spindle story always has an SP202 owner and fix', () => {
  const data = ':: StoryData\n{"format":"Spindle"}\n';
  /** The SP202 diagnostics of every document, with the fix applied to its owner. */
  function sp202(entries: Array<[string, string]>) {
    const model = new WorkspaceModel({ workspaceRoot: process.cwd() });
    models.push(model);
    model.initialize(new Map(entries));
    const found = entries.flatMap(([u]) =>
      computeDiagnostics(u, model).filter(d => d.code === 'SP202').map(d => ({ u, d })));
    return { model, found };
  }

  // The format is read from StoryData passages in non-macro documents, so
  // whichever URI holds the passages (the workspace indexes every such
  // document and the diagnostics plugin publishes for it) is the owner.
  for (const name of ['untitled:Untitled-1', 'file:///story.tw2', 'file:///notes.md', 'file:///STORY.TWEE', 'file:///story.twee']) {
    it(`M-SP202-uri: ${name} holding the StoryData is the owner; error severity; fix applies`, () => {
      const text = `${data}:: Start\nhi\n`;
      const { model, found } = sp202([['file:///empty.tw', ''], ['file:///readme.txt', 'no passages here'], [name, text]]);
      expect(found).toHaveLength(1);
      expect(found[0].u).toBe(name);
      expect(found[0].d.severity).toBe('error');
      const action = computeCodeActions(name, [found[0].d], model)[0];
      expect(action.edits.every(e => e.uri === name)).toBe(true);
      const next = TextDocument.applyEdits(
        TextDocument.create(name, 'twee', 0, text),
        action.edits.map(e => ({ range: e.range, newText: e.newText })),
      );
      expect(sp202([[name, next]]).found).toEqual([]);
    });
  }

  it('M-SP202-never-ownerless: declared Spindle implies an owner for every placement of the StoryData', () => {
    for (const name of ['untitled:a', 'file:///a.tw', 'file:///a.tw2', 'file:///a.md', 'file:///a']) {
      const model = new WorkspaceModel({ workspaceRoot: process.cwd() });
      models.push(model);
      model.initialize(new Map([['file:///empty.twee', ''], [name, data]]));
      expect(model.storyFormat).toBe('Spindle');
      expect(missingStoryVariablesOwner(model), name).toBe(name);
    }
  });

  it('M-SP202-control: only empty or passage-less documents is not a Spindle story (nothing to start): no format, no owner, no SP202', () => {
    const { model, found } = sp202([['file:///a.tw', ''], ['file:///b.twee', '\n'], ['file:///readme.md', '# Title\n'], ['file:///m.js', 'export {}\n']]);
    expect(model.storyFormat).toBeUndefined();
    expect(missingStoryVariablesOwner(model)).toBeUndefined();
    expect(found).toEqual([]);
  });

  it('M-SP202-control: a JS macro source is never the owner even if it contains a passage header', () => {
    const { found } = sp202([['file:///m.js', ':: StoryData\n{"format":"Spindle"}\n'], ['file:///s.tw', ':: Start\nhi\n']]);
    expect(found).toEqual([]);
  });
});

describe('M-EOL: header-only declaration documents take the workspace line ending', () => {
  const data = ':: StoryData\r\n{"format":"Spindle"}\r\n';
  function fix(code: string, entries: Array<[string, string]>, target: string) {
    const model = new WorkspaceModel({ workspaceRoot: process.cwd() });
    models.push(model);
    model.initialize(new Map(entries));
    const d = entries.flatMap(([u]) => computeDiagnostics(u, model).filter(x => x.code === code).map(x => ({ u, x })))[0];
    expect(d, code).toBeDefined();
    const action = computeCodeActions(d.u, [d.x], model)[0];
    expect(action.edits.every(e => e.uri === target)).toBe(true);
    const text = model.documents.getText(target)!;
    return TextDocument.applyEdits(
      TextDocument.create(target, 'twee', 0, text),
      action.edits.map(e => ({ range: e.range, newText: e.newText })),
    );
  }

  it('M-EOL-sp200: header-only StoryVariables with no newline, CRLF elsewhere', () => {
    const sv = 'file:///vars.tw';
    const out = fix('SP200', [[uri, `${data}:: Start\r\n{$x}\r\n`], [sv, ':: StoryVariables']], sv);
    expect(out).toBe(':: StoryVariables\r\n$x = 0\r\n');
  });
  it('M-EOL-sp203: header-only StoryTransients with no newline, CRLF elsewhere', () => {
    const st = 'file:///trans.tw';
    const out = fix('SP203', [[uri, `${data}:: StoryVariables\r\n:: Start\r\n{%t}\r\n`], [st, ':: StoryTransients']], st);
    expect(out).toBe(':: StoryTransients\r\n%t = 0\r\n');
  });
  it('M-EOL-sp202: single-line owner takes the CRLF of another document', () => {
    // owner is the first document with a passage; StoryData lives in the CRLF one
    const a = 'file:///a.tw';
    const out = fix('SP202', [[a, ':: A'], [uri, `${data}:: Start\r\nhi\r\n`]], a);
    expect(out).toBe(':: A\r\n\r\n:: StoryVariables\r\n');
  });
  it('M-EOL-control: LF workspace and a lone header-only document stay LF', () => {
    const sv = 'file:///vars.tw';
    expect(fix('SP200', [[uri, ':: StoryData\n{"format":"Spindle"}\n:: Start\n{$x}\n'], [sv, ':: StoryVariables']], sv))
      .toBe(':: StoryVariables\n$x = 0\n');
  });
  it('M-EOL-control: the document own CRLF wins over an LF workspace', () => {
    const sv = 'file:///vars.tw';
    expect(fix('SP200', [[uri, ':: StoryData\n{"format":"Spindle"}\n:: Start\n{$x}\n'], [sv, ':: StoryVariables\r\n']], sv))
      .toBe(':: StoryVariables\r\n$x = 0\r\n');
  });
});
