import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import type { Diagnostic } from '../../src/core/types.js';
import { runtimeRejects } from '../helpers/runtime-ast.js';

function diagnose(content: string): Diagnostic[] {
  const workspace = new WorkspaceModel();
  workspace.initialize(new Map([['file:///test.tw', content]]));
  return computeDiagnostics('file:///test.tw', workspace);
}

function codes(diags: Diagnostic[]): string[] {
  return diags.map(d => d.code);
}

function sp102(diags: Diagnostic[]): Diagnostic[] {
  return diags.filter(d => d.code === 'SP102');
}

/** Line/character range of a diagnostic, as [line, start, end]. */
function at(diag: Diagnostic): [number, number, number] {
  return [diag.range.start.line, diag.range.start.character, diag.range.end.character];
}

// Spindle's pairing (pairMarkup, which the runtime builds its AST from) reports these, and the passage
// shows "Error parsing passage" instead of its content. The tooling API reports every one of them.
describe('SP102: HTML element structure Spindle cannot render', () => {
  const vars = ':: StoryVariables\n$x = 1\n';

  it('flags an element that is never closed, at its opening tag', () => {
    const diags = diagnose(':: Start\nHello <b>world\n');
    expect(codes(diags)).toEqual(['SP102']);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].message).toBe('Unclosed <b>: no </b> closes it');
    expect(at(diags[0])).toEqual([1, 6, 9]);
  });

  it('flags every element left open at the end of the passage', () => {
    const diags = diagnose(':: Start\n<div class="a">\n<p>text\n');
    expect(diags.map(d => d.message)).toEqual([
      'Unclosed <div>: no </div> closes it',
      'Unclosed <p>: no </p> closes it',
    ]);
    expect(diags.map(at)).toEqual([[1, 0, 15], [2, 0, 3]]);
  });

  it('flags a closing tag with nothing open', () => {
    const diags = diagnose(':: Start\ntext</i>\n');
    expect(codes(diags)).toEqual(['SP102']);
    expect(diags[0].message).toBe('</i> closes nothing: no <i> is open here');
    expect(at(diags[0])).toEqual([1, 4, 8]);
  });

  it('flags a closing tag that does not match the open element', () => {
    const diags = diagnose(':: Start\n<b>bold <i>both</b></i>\n');
    expect(codes(diags)).toEqual(['SP102', 'SP102']);
    expect(diags[0].message).toBe('</b> found where </i> should close the <i> opened at line 1, column 9');
    expect(at(diags[0])).toEqual([1, 15, 19]);
    // the <i> stays open, so its own closer closes nothing
    expect(diags[1].message).toBe('</i> closes nothing: no <i> is open here');
  });

  it('flags a block closing while an element inside it is open', () => {
    const diags = diagnose(`${vars}:: Start\n{if $x}<span>a{/if}</span>\n`);
    // the rejected {/if} is blamed (a malformed container, SP101), and the </span> that follows closes nothing
    expect(codes(diags)).toEqual(['SP101', 'SP102']);
    expect(diags[0].message).toBe('{/if} found where </span> should close the <span> opened at line 1, column 8');
    expect(at(diags[0])).toEqual([3, 14, 19]);
    expect(diags[1].message).toBe('</span> closes nothing: no <span> is open here');
  });

  it('flags an element closing while a block inside it is open', () => {
    const diags = diagnose(`${vars}:: Start\n<span>{if $x}a</span>{/if}\n`);
    expect(codes(diags)).toEqual(['SP102', 'SP101']);
    expect(diags[0].message).toBe('</span> found where {/if} should close the {if} opened at line 1, column 7');
    expect(at(diags[0])).toEqual([3, 14, 21]);
  });

  it('reports every error in a passage, where Spindle fails at the first', () => {
    const diags = diagnose(':: Start\n</i> <b> </u>\n');
    expect(diags.map(d => d.message)).toEqual([
      '</i> closes nothing: no <i> is open here',
      '</u> found where </b> should close the <b> opened at line 1, column 6',
    ]);
  });

  it('checks each passage on its own', () => {
    const diags = diagnose(':: One\n<div>\n:: Two\n</div>\n:: Three\n<p>fine</p>\n');
    expect(diags.map(d => [d.message, d.range.start.line])).toEqual([
      ['Unclosed <div>: no </div> closes it', 1],
      ['</div> closes nothing: no <div> is open here', 3],
    ]);
  });

  it('reports alongside a branch that Spindle rejects inside the element', () => {
    const diags = diagnose(`${vars}:: Start\n{if $x}<p>a{else}b{/if}\n`);
    expect(codes(diags).sort()).toEqual(['SP101', 'SP107']);
    expect(diags.find(d => d.code === 'SP101')!.message).toBe('{/if} found where </p> should close the <p> opened at line 1, column 8');
  });

  it('reports an element error before an unpaired container, and one at a closing tag over it', () => {
    const before = diagnose(`${vars}:: Start\n</i>{if $x}\n`);
    expect(codes(before)).toEqual(['SP102', 'SP101']);
    // The unclosed {if} stays open, so </i> is the closer found where {/if} should close
    const after = diagnose(`${vars}:: Start\n{if $x}</i>\n`);
    expect(codes(after)).toEqual(['SP102']);
    expect(sp102(after)[0].message).toBe('</i> found where {/if} should close the {if} opened at line 1, column 1');
  });

  it('does not read tags inside a closed HTML comment', () => {
    // The comment is one text token: markdown drops it, and so does raw rendering
    expect(diagnose(':: Start\n<!-- <div> -->\n')).toEqual([]);
  });

  it('accepts well-formed markup', () => {
    expect(diagnose(`${vars}:: Start\n<div class="a">{if $x}<b>a</b>{else}<i>b</i>{/if}</div>\n`)).toEqual([]);
    expect(diagnose(':: Start\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n')).toEqual([]);
  });

  it('matches closing tags case-insensitively', () => {
    expect(diagnose(':: Start\n<SPAN>a</span>\n')).toEqual([]);
  });

  it('accepts void elements and self-closing tags', () => {
    expect(diagnose(':: Start\na<br>b<hr/><img src="x.png"><div/><wbr>\n')).toEqual([]);
  });

  it('does not flag the other void elements of HTML', () => {
    expect(diagnose(`${vars}:: Start\n<input type="text"> {if $x}<source src="a">{/if}\n`)).toEqual([]);
    expect(diagnose(':: Start\n<input></input>\n')).toEqual([]);
    expect(diagnose(':: Start\na</br>b\n')).toEqual([]);
  });

  it('ignores tags inside macro arguments, displays and links', () => {
    expect(diagnose(`${vars}:: Start\n{print "<b>"}{$x + "</i>"}\n`)).toEqual([]);
    expect(diagnose(':: Next\nx\n:: Start\n[[<b>Go|Next]]\n')).toEqual([]);
  });

  it('reads attribute values, tags with spaces around = and {do} bodies as Spindle does', () => {
    // The value of an attribute ends at its closing quote: the lone `{` is no markup that runs on
    expect(diagnose(':: Start\n<a title="{">x</a>\n')).toEqual([]);
    // `<a href = "x">` is a tag (href = x), which `</a>` closes
    expect(diagnose(':: Start\n<a href = "x">x</a>\n')).toEqual([]);
    expect(sp102(diagnose(':: Start\n<a href = "x">x\n')).map(d => d.message)).toEqual(['Unclosed <a>: no </a> closes it']);
    // A {do} body is JavaScript: the tag in it is none
    expect(sp102(diagnose(':: Start\n{do} el.innerHTML = "<b>hi"; {/do}\n'))).toEqual([]);
  });

  it('agrees with the runtime', () => {
    for (const body of ['<a title="{">x</a>', '<a title="{">x</i>', '<a href = "x">x', '<a href = "x">x</a>', '{do} el.innerHTML = "<b>hi"; {/do}']) {
      const found = diagnose(`:: Start\n${body}\n`).some(d => ['SP101', 'SP102', 'SP104'].includes(d.code));
      expect(found, body).toBe(runtimeRejects(body));
    }
  });

  it('reads on after a link that never closes, as Spindle does', () => {
    // The tokenizer reads `[[` as text (SP105) and the <b> as a tag
    const diags = diagnose(':: Start\n[[unclosed <b>\n');
    expect(diags.map(d => [d.code, d.message])).toEqual([
      ['SP105', 'Unclosed link: [[ without ]]'],
      ['SP102', 'Unclosed <b>: no </b> closes it'],
    ]);
    expect(codes(diagnose(':: Start\n[[unclosed <b>x</b>\n'))).toEqual(['SP105']);
  });

  it('reads on after a closing tag with no name', () => {
    // Spindle fails at the `{/` ("A closing tag starts with a letter") and reads on from there
    expect(diagnose(':: Start\n{/}<b>\n').map(d => [d.code, d.message])).toEqual([
      ['SP104', 'A closing tag starts with a letter after {/'],
      ['SP102', 'Unclosed <b>: no </b> closes it'],
    ]);
  });

  it('reports each error of a passage', () => {
    const diags = diagnose(':: Start\n</i><a href = "x">x\n');
    expect(diags.map(d => d.message)).toEqual([
      '</i> closes nothing: no <i> is open here',
      'Unclosed <a>: no </a> closes it',
    ]);
  });

  it('checks passages Spindle renders as markup', () => {
    for (const header of [
      ':: StoryInit', ':: StoryInterface', ':: PassageHeader', ':: PassageDone',
      ':: StoryLoading', ':: Widgets [widget]', ':: Page [nobr]',
    ]) {
      expect(codes(diagnose(`${header}\n<div>\n`)), header).toEqual(['SP102']);
    }
  });

  it('skips passages Spindle never tokenizes', () => {
    for (const passage of [
      ':: StoryTitle\n<b>Title\n',
      ':: StoryData\n{"ifid": "<b>"}\n',
      ':: StoryVariables\n$x = "<b>"\n',
      ':: StoryTransients\n%y = "</i>"\n',
      ':: SaveTitle\nreturn "<b>" + passage;\n',
      ':: Script [script]\nvar s = "<div>";\n',
      ':: Style [stylesheet]\n/* <div> */\n',
    ]) {
      expect(sp102(diagnose(passage)), passage).toEqual([]);
    }
  });
});
