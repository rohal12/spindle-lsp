import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import type { DiagnosticOptions } from '../../src/plugins/diagnostics.js';

function createWorkspaceFrom(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const model = new WorkspaceModel();
  const fileContents = new Map<string, string>();
  for (const f of files) {
    fileContents.set(`file:///${f.name}`, f.content);
  }
  model.initialize(fileContents);
  return model;
}

function diagnose(text: string, options?: DiagnosticOptions) {
  const workspace = createWorkspaceFrom({ name: 'test.tw', content: text });
  return computeDiagnostics('file:///test.tw', workspace, options);
}

function codes(text: string, code: string, options?: DiagnosticOptions) {
  return diagnose(text, options).filter(d => d.code === code);
}

describe('SP101: container nesting and passage boundaries', () => {
  it('reports containers that would pair across passages', () => {
    const sp101 = codes(':: Start\n{if true}\n:: Other\n{/if}', 'SP101');
    expect(sp101).toHaveLength(2);
    expect(sp101.map(d => d.range.start.line).sort()).toEqual([1, 3]);
  });

  it('reports crossed containers in one passage', () => {
    const sp101 = codes(':: Start\n{if true}{for @x of []}{/if}{/for}', 'SP101');
    expect(sp101).toHaveLength(2);
    // pairMarkup: the first closer is found where {/for} should close, and the second closes nothing
    expect(sp101.some(d => d.message.startsWith('{/if} found where {/for} should close the {for}'))).toBe(true);
    expect(sp101.some(d => d.message === '{/for} closes nothing: no {for} is open here')).toBe(true);
  });

  it('accepts properly nested containers', () => {
    const sp101 = codes(':: Start\n{if true}{for @x of []}{/for}{/if}\n:: Other\n{if false}x{/if}', 'SP101');
    expect(sp101).toHaveLength(0);
  });
});

describe('argument validation', () => {
  // Spindle declares the parameters of the macros it defines and the tooling API reports the arguments that do not have
  // their form (`argument-error`, SP109). Arguments the runtime does not reject (a missing target, a receiver that is
  // no variable, an extra word) are not diagnosed, whatever the LSP's own schema (macro-supplements.json) says.
  it('accepts the documented form controls', () => {
    const text = [
      ':: Start',
      '{textbox $name}',
      '{textbox "$name" "Enter your name"}',
      '{numberbox $health}',
      '{textarea $notes "Enter notes here"}',
      '{checkbox $has_key "Take the key?"}',
      '{radiobutton $class "warrior" "Warrior"}',
      '{listbox "$weapon"}{option "Sword"}{/listbox}',
      '{cycle $stance}{option "Offensive"}{/cycle}',
    ].join('\n');
    const argDiags = diagnose(text).filter(d => ['SP108', 'SP109', 'SP111'].includes(d.code));
    expect(argDiags).toEqual([]);
  });

  it('reports arguments that do not have their parameter\'s form as Spindle does (SP109)', () => {
    const diags = diagnose(':: Start\n{link Go}x{/link}');
    const sp109 = diags.filter(d => d.code === 'SP109');
    expect(sp109).toHaveLength(1);
    expect(sp109[0].severity).toBe('error');
    expect(sp109[0].message).toBe('The text must be a quoted string ("\u2026" or \'\u2026\'), not Go in {link Go}');
    expect(sp109[0].range).toEqual({ start: { line: 1, character: 6 }, end: { line: 1, character: 8 } });
  });

  it('does not report what the runtime does not reject', () => {
    const text = ':: Start\n{textbox 42 "x"}\n{dialog "Open" extra}Start{/dialog}\n{include}\n{include inline}\n{goto}\n{back 1}';
    expect(diagnose(text).filter(d => /^SP1(08|09|10|11)$/.test(d.code))).toEqual([]);
  });

  it('checks the arguments of a configured macro against its parameter schema, and isolates a malformed schema', () => {
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: ':: Start\n{broken 1}\n{ban}\n{ban "x"}\n{ban "x" "y"}' });
    workspace.macros.loadSupplements({
      broken: { name: 'broken', parameters: ['nosuchtype'] },
      ban: { name: 'ban', parameters: ['text'] },
    });
    const diags = computeDiagnostics('file:///test.tw', workspace);
    expect(diags.filter(d => /^SP1(08|09|10|11)$/.test(d.code)).map(d => [d.code, d.range.start.line, d.message.startsWith('{ban}')])).toEqual([
      ['SP109', 2, true],
      ['SP111', 4, true],
    ]);
  });
});

describe('{include} arguments', () => {
  const target = '\n:: Target\nText';

  it('accepts a trailing inline modifier', () => {
    const diags = diagnose(`:: Start\n{include "Target" inline}${target}`);
    expect(diags).toEqual([]);
  });

  it('accepts a leading inline modifier', () => {
    const diags = diagnose(`:: Start\n{include inline "Target"}${target}`);
    expect(diags).toEqual([]);
  });

  it('accepts a dynamic expression target containing whitespace', () => {
    const text = `:: StoryVariables\n$suffix = "get"\n\n:: Start\n{include "Tar" + $suffix}${target}`;
    expect(diagnose(text)).toEqual([]);
  });

  it('reads a target without quotes as an expression, as Spindle does', () => {
    // There is no text fallback: `{include Target}` throws a ReferenceError, and Spindle reports the unquoted name
    expect(codes(`:: Start\n{include Target}${target}`, 'SP113')).toHaveLength(1);
    expect(codes(`:: Start\n{include Target inline}${target}`, 'SP113')).toHaveLength(1);
  });
});

describe('{goto} arguments', () => {
  const chapter = '\n:: Chapter 1\nHello';

  it('accepts a literal target', () => {
    expect(diagnose(`:: Start\n{goto "Chapter 1"}${chapter}`)).toEqual([]);
    expect(diagnose(`:: Start\n{goto 'Chapter 1'}${chapter}`)).toEqual([]);
  });

  it('accepts a dynamic expression target containing whitespace', () => {
    const text = `:: StoryVariables\n$n = 1\n\n:: Start\n{goto "Chapter " + $n}\n{.cls goto "Chapter " + $n}${chapter}`;
    expect(diagnose(text)).toEqual([]);
  });

  it('reads a bare multiword target as code, which is a syntax error (there is no text fallback)', () => {
    const sp106 = codes(`:: Start\n{goto Chapter 1}${chapter}`, 'SP106');
    expect(sp106).toHaveLength(1);
    expect(sp106[0].severity).toBe('error');
    expect(sp106[0].message).toContain('a passage name is a quoted string or an expression');
  });
});

describe('script and stylesheet passages', () => {
  it('does not report macro-looking text inside a script passage', () => {
    const diags = diagnose(':: Script [script]\nconst s = "{nosuch}";\nconst t = "{/if}";');
    expect(diags.filter(d => d.code.startsWith('SP1'))).toEqual([]);
  });

  it('does not report link-looking text inside a stylesheet passage', () => {
    const diags = diagnose(':: Styles [stylesheet]\n/* [[Nowhere]] */\nbody { color: red; }');
    expect(diags.filter(d => d.code === 'SP300' || d.code.startsWith('SP1'))).toEqual([]);
  });

  it('recognises the script tag among several tags', () => {
    const diags = diagnose(':: Script [script extra]\nconst s = "{nosuch} [[Nowhere]]";');
    expect(diags.filter(d => d.code === 'SP100' || d.code === 'SP300')).toEqual([]);
  });

  it('still checks story passages next to a script passage', () => {
    const text = ':: Script [script]\nconst s = "{nosuch}";\n\n:: Start\n{nosuch}\n[[Nowhere]]';
    const diags = diagnose(text);
    const sp100 = diags.filter(d => d.code === 'SP100');
    expect(sp100).toHaveLength(1);
    expect(sp100[0].range.start.line).toBe(4);
    expect(diags.filter(d => d.code === 'SP300')).toHaveLength(1);
  });
});

describe('SP500: line length', () => {
  it('skips script and stylesheet passage bodies', () => {
    const text = [
      ':: Script [script]',
      'const someLongVariable = 1234567890;',
      ':: Styles [stylesheet]',
      'body { color: red; background: blue; }',
      ':: Start',
      'This prose line is far too long.',
    ].join('\n');
    const sp500 = codes(text, 'SP500', { maxLineLength: 10 });
    expect(sp500).toHaveLength(1);
    expect(sp500[0].range.start.line).toBe(5);
  });
});
