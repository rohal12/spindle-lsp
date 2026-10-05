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
    // Spindle throws "Expected {/for} but found {/if}" at the first closer
    expect(sp101.some(d => d.message.includes('expected {/for} but found {/if}'))).toBe(true);
    expect(sp101.some(d => d.message.includes('no matching {/if}'))).toBe(true);
  });

  it('accepts properly nested containers', () => {
    const sp101 = codes(':: Start\n{if true}{for @x of []}{/for}{/if}\n:: Other\n{if false}x{/if}', 'SP101');
    expect(sp101).toHaveLength(0);
  });
});

describe('argument validation with receiver parameters', () => {
  it('validates macros that follow a receiver macro', () => {
    const sp109 = codes(':: Start\n{textbox "$x" ""}\n{goto}', 'SP109');
    expect(sp109).toHaveLength(1);
    expect(sp109[0].message).toContain('{goto}');
  });

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

  it('accepts the noclose modifier of dialog', () => {
    const text = ':: Start\n{dialog "Open" noclose}Target{/dialog}\n{dialog "Open"}Target{/dialog}\n:: Target\nHi';
    expect(diagnose(text).filter(d => ['SP109', 'SP111'].includes(d.code))).toEqual([]);
    expect(codes(':: Start\n{dialog "Open" extra}Target{/dialog}', 'SP109')).toHaveLength(1);
  });

  it('rejects a receiver that is not a variable', () => {
    const sp109 = codes(':: Start\n{textbox 42 "x"}', 'SP109');
    expect(sp109).toHaveLength(1);
    expect(sp109[0].message).toContain('receiver');
  });

  it('isolates a malformed custom parameter schema to its own macro', () => {
    const workspace = createWorkspaceFrom({ name: 'test.tw', content: ':: Start\n{broken 1}\n{goto}' });
    workspace.macros.loadSupplements({ broken: { name: 'broken', parameters: ['nosuchtype'] } });
    const diags = computeDiagnostics('file:///test.tw', workspace);
    expect(diags.filter(d => d.code === 'SP109' && d.message.includes('{goto}'))).toHaveLength(1);
  });
});

describe('{include} arguments', () => {
  const target = '\n:: Target\nText';

  it('accepts a trailing inline modifier', () => {
    const diags = diagnose(`:: Start\n{include "Target" inline}${target}`);
    expect(diags.filter(d => ['SP109', 'SP111'].includes(d.code))).toEqual([]);
  });

  it('accepts a leading inline modifier', () => {
    const diags = diagnose(`:: Start\n{include inline "Target"}${target}`);
    expect(diags.filter(d => ['SP109', 'SP111'].includes(d.code))).toEqual([]);
  });

  it('accepts a dynamic expression target containing whitespace', () => {
    const text = `:: StoryVariables\n$suffix = "get"\n\n:: Start\n{include "Tar" + $suffix}${target}`;
    const diags = diagnose(text);
    expect(diags.filter(d => ['SP109', 'SP111'].includes(d.code))).toEqual([]);
  });

  it('still reports a missing target', () => {
    expect(codes(':: Start\n{include}', 'SP109')).toHaveLength(1);
    expect(codes(':: Start\n{include inline}', 'SP109')).toHaveLength(1);
  });
});

describe('{goto} arguments', () => {
  const chapter = '\n:: Chapter 1\nHello';
  const argDiags = (text: string) => diagnose(text).filter(d => ['SP108', 'SP109', 'SP111'].includes(d.code));

  it('accepts a literal target', () => {
    expect(argDiags(`:: Start\n{goto "Chapter 1"}${chapter}`)).toEqual([]);
    expect(argDiags(`:: Start\n{goto 'Chapter 1'}${chapter}`)).toEqual([]);
  });

  it('accepts a dynamic expression target containing whitespace', () => {
    const text = `:: StoryVariables\n$n = 1\n\n:: Start\n{goto "Chapter " + $n}\n{.cls goto "Chapter " + $n}${chapter}`;
    expect(argDiags(text)).toEqual([]);
  });

  it('accepts a bare multiword target, which Spindle reads as raw text', () => {
    expect(argDiags(`:: Start\n{goto Chapter 1}${chapter}`)).toEqual([]);
  });

  it('still reports a missing target', () => {
    const sp109 = codes(':: Start\n{goto}\n{goto   }', 'SP109');
    expect(sp109.map(d => d.range.start.line)).toEqual([1, 2]);
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
