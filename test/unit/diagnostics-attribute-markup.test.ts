import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import type { Diagnostic } from '../../src/core/types.js';
import { runtimeAttributeValues } from '../helpers/runtime-ast.js';

function diagnose(content: string): Diagnostic[] {
  const workspace = new WorkspaceModel();
  workspace.initialize(new Map([['file:///test.tw', content]]));
  return computeDiagnostics('file:///test.tw', workspace);
}

/** Line/character range of a diagnostic, as [line, start, end]. */
function at(diag: Diagnostic): [number, number, number] {
  return [diag.range.start.line, diag.range.start.character, diag.range.end.character];
}

const vars = ':: StoryVariables\n$n = 1\n$x = false\n$s = "a"\n';

// In Spindle 0.59 the value of an HTML attribute holds markup: a macro in it is a real macro and the runtime
// evaluates it. (Earlier releases output a macro there as text, which SP103 warned about; the diagnostic is gone.)
describe('markup in the value of an HTML attribute', () => {
  it('accepts the macro from issue #63, which Spindle evaluates', () => {
    const line = '<span class="{if @d.delta > 0}delta-positive{else}delta-negative{/if}">x</span>';
    expect(diagnose(`${vars}:: Start\n{set @d = {delta: $n}}\n${line}\n`)).toEqual([]);
  });

  it('accepts what Spindle evaluates', () => {
    const story = `${vars}:: StoryTransients\n%t = 1\n:: Start\n`
      + `{set _t = 1}<span class="{$n} {_t} {%t} {$n > 0 ? 'pos' : 'neg'}" id={$s}>y</span>\n`
      + `{for @l of [1]}<b title="{@l}">{@l}</b>{/for}\n`
      + `<span class="{!$n ? 'zero' : 'nonzero'}" title={($n)}>z</span>\n`;
    expect(diagnose(story)).toEqual([]);
  });

  it('accepts a widget invocation in a value', () => {
    const story = `${vars}:: Widgets [widget]\n{widget "Badge"}b{/widget}\n:: Start\n{Badge}<i title="{Badge}">t</i>\n`;
    expect(diagnose(story)).toEqual([]);
  });

  it('flags a macro in a value that is never closed, at the macro, naming the attribute', () => {
    const diags = diagnose(`${vars}:: Start\n{if $n}<span class="a {if $x}on">t</span>{/if}\n`);
    expect(diags.map(d => [d.code, d.message])).toEqual([
      ['SP101', 'In the class attribute of <span>: Unclosed {if}: no {/if} closes it'],
    ]);
    expect(at(diags[0])).toEqual([5, 22, 29]);
  });

  it('flags a closing tag in a value that closes nothing', () => {
    const diags = diagnose(`${vars}:: Start\n<a title="{print $n}" data-x="{/for}">t</a>\n`);
    expect(diags.map(d => [d.code, d.message])).toEqual([
      ['SP101', 'In the data-x attribute of <a>: {/for} closes nothing: no {for} is open here'],
    ]);
  });

  it('flags braces that are macros to Spindle: an unknown macro in a value', () => {
    // `{name}` and `{color: red}` read as macros; write `\\{` for a literal brace
    const diags = diagnose(`${vars}:: Start\n<span data-x='{"a":1}' data-y="{name}" style="{color: red}">j</span>\n`);
    expect(diags.map(d => d.code)).toEqual(['SP100', 'SP100']);
    expect(diags[0].message).toMatch(/^In the data-y attribute of <span>: Unknown macro \{name\}\./);
    expect(diags[1].message).toBe('In the style attribute of <span>: Unknown macro {color:}.');
  });

  it('checks the variables in a value', () => {
    const diags = diagnose(`${vars}:: Start\n<a title="{$undeclared}" onclick="{$x}">t</a>\n`);
    expect(diags.map(d => [d.code, d.message])).toEqual([['SP200', 'Undeclared variable: $undeclared']]);
    expect(at(diags[0])).toEqual([5, 11, 22]);
  });

  it('follows elements past macros inside a tag', () => {
    const diags = diagnose(`${vars}:: Start\n<div class="{if $x}a{/if}"><b>t</div>\n`);
    expect(diags.map(d => [d.code, d.message])).toEqual([
      ['SP102', '</div> found where </b> should close the <b> opened at line 1, column 28'],
    ]);
  });

  it('reads a tag with whitespace around = as a tag', () => {
    // `href` has the value `x`, and the `<b>` after it is a tag too
    const body = '<a href = "x"> <b title="{if $x}a{/if}">t</b></a>';
    expect(diagnose(`${vars}:: Start\n${body}\n`)).toEqual([]);
    expect(runtimeAttributeValues(body)).toEqual(['x', '{if $x}a{/if}']);
  });

  it('ignores script, stylesheet and other passages Spindle does not tokenize', () => {
    const story = `${vars}:: Script [script]\nvar s = '<b title="{if $x}a{/if}">';\n`
      + `:: Style [stylesheet]\n/* <b title="{if $x}a{/if}"> */\n`
      + `:: StoryTitle\n<b title="{if $x}a{/if}">T</b>\n:: Start\nx\n`;
    expect(diagnose(story)).toEqual([]);
  });

  it('reports nothing for other story formats', () => {
    const story = ':: StoryData\n{"format":"SugarCube"}\n:: Start\n<span class="{if $x}a{/if}">t</span>\n';
    expect(diagnose(story)).toEqual([]);
  });
});
