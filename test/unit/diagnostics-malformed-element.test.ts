import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import type { Diagnostic } from '../../src/core/types.js';
import { runtimeRejects } from '../helpers/runtime-ast.js';
import { INSTALLED_CAPABILITIES } from '../helpers/spindle-version.js';

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

// Spindle's buildAST (markup/ast.ts) throws on these, and the passage shows
// "Error parsing passage" instead of its content.
describe('SP102: HTML element structure Spindle cannot render', () => {
  const vars = ':: StoryVariables\n$x = 1\n';

  it('flags an element that is never closed, at its opening tag', () => {
    const diags = diagnose(':: Start\nHello <b>world\n');
    expect(codes(diags)).toEqual(['SP102']);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].message).toBe('Malformed element: unclosed <b>');
    expect(at(diags[0])).toEqual([1, 6, 9]);
  });

  it('flags every element left open at the end of the passage', () => {
    const diags = diagnose(':: Start\n<div class="a">\n<p>text\n');
    expect(diags.map(d => d.message)).toEqual([
      'Malformed element: unclosed <div>',
      'Malformed element: unclosed <p>',
    ]);
    expect(diags.map(at)).toEqual([[1, 0, 15], [2, 0, 3]]);
  });

  it('flags a closing tag with nothing open', () => {
    const diags = diagnose(':: Start\ntext</i>\n');
    expect(codes(diags)).toEqual(['SP102']);
    expect(diags[0].message).toBe('Malformed element: unexpected closing </i>');
    expect(at(diags[0])).toEqual([1, 4, 8]);
  });

  it('flags a closing tag that does not match the open element', () => {
    const diags = diagnose(':: Start\n<b>bold <i>both</b></i>\n');
    expect(codes(diags)).toEqual(['SP102']);
    expect(diags[0].message).toBe('Malformed element: expected </i> but found </b>');
    expect(at(diags[0])).toEqual([1, 15, 19]);
  });

  it('flags a block closing while an element inside it is open', () => {
    const diags = diagnose(`${vars}:: Start\n{if $x}<span>a{/if}</span>\n`);
    // Like crossed macros ({wrap}{if}{/wrap}{/if}), the rejected closer is
    // blamed and the container it would close stays open (SP101)
    expect(codes(diags).sort()).toEqual(['SP101', 'SP102']);
    expect(sp102(diags)[0].message).toBe('Malformed element: expected </span> but found {/if}');
    expect(at(sp102(diags)[0])).toEqual([3, 14, 19]);
    expect(diags.find(d => d.code === 'SP101')!.message).toBe('Malformed container: no matching {/if}');
  });

  it('flags an element closing while a block inside it is open', () => {
    const diags = diagnose(`${vars}:: Start\n<span>{if $x}a</span>{/if}\n`);
    expect(codes(diags)).toEqual(['SP102']);
    expect(diags[0].message).toBe('Malformed element: expected {/if} but found </span>');
    expect(at(diags[0])).toEqual([3, 14, 21]);
  });

  it('reports only the first error in a passage, where Spindle throws', () => {
    const diags = diagnose(':: Start\n</i> <b> </u>\n');
    expect(diags.map(d => d.message)).toEqual(['Malformed element: unexpected closing </i>']);
  });

  it('checks each passage on its own', () => {
    const diags = diagnose(':: One\n<div>\n:: Two\n</div>\n:: Three\n<p>fine</p>\n');
    expect(diags.map(d => [d.message, d.range.start.line])).toEqual([
      ['Malformed element: unclosed <div>', 1],
      ['Malformed element: unexpected closing </div>', 3],
    ]);
  });

  it('reports alongside a branch that Spindle rejects inside the element', () => {
    const diags = diagnose(`${vars}:: Start\n{if $x}<p>a{else}b{/if}\n`);
    expect(codes(diags).sort()).toEqual(['SP102', 'SP107']);
    expect(sp102(diags)[0].message).toBe('Malformed element: expected </p> but found {/if}');
  });

  it('reports an element error before an unpaired container, and one at a closing tag over it', () => {
    const before = diagnose(`${vars}:: Start\n</i>{if $x}\n`);
    expect(codes(before).sort()).toEqual(['SP101', 'SP102']);
    // The unclosed {if} stays on Spindle's stack, so </i> is the closer it rejects
    const after = diagnose(`${vars}:: Start\n{if $x}</i>\n`);
    expect(codes(after).sort()).toEqual(['SP101', 'SP102']);
    expect(sp102(after)[0].message).toBe('Malformed element: expected {/if} but found </i>');
  });

  it('sees tags inside HTML comments, as Spindle\'s tokenizer does', () => {
    const diags = diagnose(':: Start\n<!-- <div> -->\n');
    expect(diags.map(d => d.message)).toEqual(['Malformed element: unclosed <div>']);
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

  it('does not flag void elements that Spindle 0.45.1 still expects to be closed', () => {
    // 0.45.1 treats only br, col, hr, img and wbr as void; later versions know
    // the rest and drop their closing tags.
    expect(diagnose(`${vars}:: Start\n<input type="text"> {if $x}<source src="a">{/if}\n`)).toEqual([]);
    expect(diagnose(':: Start\n<input></input>\n')).toEqual([]);
    expect(diagnose(':: Start\na</br>b\n')).toEqual([]);
  });

  it('ignores tags inside macro arguments, displays and links', () => {
    expect(diagnose(`${vars}:: Start\n{print "<b>"}{$x + "</i>"}\n`)).toEqual([]);
    expect(diagnose(':: Next\nx\n:: Start\n[[<b>Go|Next]]\n')).toEqual([]);
  });

  it('reads the places where Spindle releases differ as the target release does', () => {
    const at = (body: string, version?: string) => diagnose(
      `:: Start\n${body}\n`
      + (version ? `:: StoryData\n{"format": "Spindle", "format-version": "${version}"}\n` : ''),
    );
    // 0.43.0-0.50.0 end the attribute value at a quote outside braces (here
    // none: no tag, and `</a>` is unexpected); 0.50.1 skips the lone `{`
    // (the tag is `<a>`, which `</a>` closes).
    for (const version of [undefined, '0.45.1', '0.50.0']) {
      expect(sp102(at('<a title="{">x</a>', version)).map(d => d.message), String(version))
        .toEqual(['Malformed element: unexpected closing </a>']);
    }
    for (const version of ['0.50.1', '0.51.3']) {
      expect(sp102(at('<a title="{">x</a>', version)), version).toEqual([]);
    }
    // Whitespace around = is text in every release: `<a href = "x">` is no tag.
    expect(diagnose(':: Start\n<a href = "x">x\n')).toEqual([]);
    expect(sp102(diagnose(':: Start\n<a href = "x">x</a>\n')).map(d => d.message))
      .toEqual(['Malformed element: unexpected closing </a>']);
    // 0.50.1 and later keep a {do} body as JavaScript; before, the tag in it is read.
    expect(sp102(at('{do} el.innerHTML = "<b>hi"; {/do}', '0.51.3'))).toEqual([]);
    expect(sp102(at('{do} el.innerHTML = "<b>hi"; {/do}')).map(d => d.message)).toEqual(['Malformed element: expected </b> but found {/do}']);
  });

  it('agrees with the installed runtime where releases differ', () => {
    const workspaceRoot = process.cwd();
    for (const body of ['<a title="{">x</a>', '<a title="{">x</i>', '<a href = "x">x', '<a href = "x">x</a>', '{do} el.innerHTML = "<b>hi"; {/do}']) {
      const workspace = new WorkspaceModel({ workspaceRoot });
      workspace.initialize(new Map([['file:///test.tw', `:: Start\n${body}\n`]]));
      const found = computeDiagnostics('file:///test.tw', workspace).some(d => ['SP101', 'SP102', 'SP104'].includes(d.code));
      expect(found, `${body} (${INSTALLED_CAPABILITIES.version})`).toBe(runtimeRejects(body));
    }
  });

  it('reads on after a link that never closes, as Spindle does', () => {
    // The tokenizer reads `[[unclosed ` as text and the <b> as a tag that
    // buildAST never sees closed.
    expect(diagnose(':: Start\n[[unclosed <b>\n').map(d => d.message)).toEqual(
      [expect.stringMatching(/^Malformed element: unclosed <b>/)],
    );
    expect(diagnose(':: Start\n[[unclosed <b>x</b>\n')).toEqual([]);
  });

  it('does not report after a macro Spindle reads but the macro parser does not', () => {
    // Spindle throws "Unexpected closing {/}" there, not at the <b>.
    expect(sp102(diagnose(':: Start\n{/}<b>\n'))).toEqual([]);
  });

  it('still reports an error before the reading becomes uncertain', () => {
    const diags = diagnose(':: Start\n</i><a href = "x">x\n');
    expect(diags.map(d => d.message)).toEqual(['Malformed element: unexpected closing </i>']);
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
