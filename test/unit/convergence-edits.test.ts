/**
 * Applied-edit contracts moved from test/review/convergence.review.ts:
 * Q68 (#68), Q69 (#69), E75 (#75). Edits are applied with
 * TextDocument.applyEdits and the result is re-parsed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { tokenize } from '../../node_modules/@rohal12/spindle/src/markup/tokenizer.js';
import { parseStoryVariables } from '../../node_modules/@rohal12/spindle/src/story-variables.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import type { Range } from '../../src/core/types.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeCodeActions } from '../../src/plugins/code-actions.js';
import { getCompletions } from '../../src/plugins/completions.js';

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
