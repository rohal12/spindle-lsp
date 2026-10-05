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

function sp103(diags: Diagnostic[]): Diagnostic[] {
  return diags.filter(d => d.code === 'SP103');
}

/** Line/character range of a diagnostic, as [line, start, end]. */
function at(diag: Diagnostic): [number, number, number] {
  return [diag.range.start.line, diag.range.start.character, diag.range.end.character];
}

const vars = ':: StoryVariables\n$n = 1\n$x = false\n$s = "a"\n';
const MACRO_MESSAGE = "Macros are not evaluated inside HTML attributes, so Spindle outputs this {if} as text. "
  + "Use an expression such as {$x ? 'a' : 'b'}";

// Spindle's HtmlNodeRenderer passes attribute values through interpolate(),
// which evaluates a {…} block only when a sigil follows the brace directly
// (rohal12/spindle#225).
describe('SP103: {…} in an HTML attribute that Spindle outputs as text', () => {
  it('flags the macro from issue #63, once over the whole construct', () => {
    const line = '<span class="{if @d.delta > 0}delta-positive{else}delta-negative{/if}">x</span>';
    const diags = diagnose(`${vars}:: Start\n${line}\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ code: 'SP103', severity: 'warning', message: MACRO_MESSAGE });
    expect(at(diags[0])).toEqual([5, 13, line.indexOf('{/if}') + 5]);
  });

  it('reports no container or element errors for macros inside a tag', () => {
    // The {if} in the attribute is text: the outer {if} pairs with the last {/if}.
    const diags = diagnose(`${vars}:: Start\n{if $n}<span class="a {if $x}on">t</span>{/if}\n`);
    expect(diags.map(d => d.code)).toEqual(['SP103']);
    expect(at(diags[0])).toEqual([5, 22, 29]);
  });

  it('follows elements past macros inside a tag', () => {
    const diags = diagnose(`${vars}:: Start\n<div class="{if $x}a{/if}"><b>t</div>\n`);
    expect(diags.map(d => [d.code, d.message])).toEqual([
      ['SP102', 'Malformed element: expected </b> but found </div>'],
      ['SP103', MACRO_MESSAGE],
    ]);
  });

  it('flags expressions that do not start with a sigil', () => {
    const diags = diagnose(`${vars}:: Start\n<span class="{!$n ? 'zero' : 'nonzero'}" title={($n)}>z</span>\n`);
    expect(sp103(diags).map(at)).toEqual([[5, 13, 39], [5, 47, 53]]);
    expect(diags[0].message).toBe(
      'Spindle evaluates {…} in an HTML attribute only when $, _, @ or % follows the brace, '
      + "so it outputs this block as text. Start the expression with a variable, as in {$x ? 'a' : 'b'}",
    );
  });

  it('names the macro in the message', () => {
    const diags = diagnose(`${vars}:: Start\n<a title="{print $n}" data-x="{/for}">t</a>\n`);
    expect(diags.map(d => d.message.split(',')[0])).toEqual([
      'Macros are not evaluated inside HTML attributes',
      'Macros are not evaluated inside HTML attributes',
    ]);
    expect(diags[0].message).toContain('this {print}');
    expect(diags[1].message).toContain('this {/for}');
  });

  it('flags widgets in attribute values', () => {
    const story = `${vars}:: Widgets [widget]\n{widget "Badge"}b{/widget}\n:: Start\n{Badge}<i title="{Badge}">t</i>\n`;
    expect(sp103(diagnose(story)).map(at)).toEqual([[7, 17, 24]]);
  });

  it('does not flag what Spindle evaluates', () => {
    const story = `${vars}:: StoryTransients\n%t = 1\n:: Start\n`
      + `{set _t = 1}<span class="{$n} {_t} {%t} {$n > 0 ? 'pos' : 'neg'}" id={$s}>y</span>\n`
      + `{for @l of [1]}<b title="{@l}">{@l}</b>{/for}\n`;
    expect(diagnose(story)).toEqual([]);
  });

  it('does not flag braces that are not code', () => {
    const story = `${vars}:: Start\n<span data-x='{"a":1}' data-y="{name}" style="{color: red}">j</span>\n`;
    expect(diagnose(story)).toEqual([]);
  });

  it('does not flag macros outside attributes', () => {
    expect(diagnose(`${vars}:: Start\n{if $n}<b>ok</b>{else}<i>no</i>{/if}\n`)).toEqual([]);
  });

  it('flags nothing in tags Spindle reads as text', () => {
    // The unquoted value ends at the space and the tag never reaches its >:
    // Spindle reads the {if} and {/if} as macros.
    const diags = diagnose(`${vars}:: Start\n<span class={if $x}a{/if}>t\n`);
    expect(sp103(diags)).toEqual([]);
  });

  it('does not look inside <script> and <style> elements', () => {
    const story = `${vars}:: Start\n<script>var s = '<b title="{if $x}a{/if}">';</script>\n`
      + `<style>.a{color:red}</style>\n`;
    expect(sp103(diagnose(story))).toEqual([]);
  });

  it('ignores script, stylesheet and other passages Spindle does not tokenize', () => {
    const story = `${vars}:: Script [script]\nvar s = '<b title="{if $x}a{/if}">';\n`
      + `:: Style [stylesheet]\n/* <b title="{if $x}a{/if}"> */\n`
      + `:: StoryTitle\n<b title="{if $x}a{/if}">T</b>\n:: Start\nx\n`;
    expect(sp103(diagnose(story))).toEqual([]);
  });

  it('reads a tag with whitespace around = as text, in every release', () => {
    // `<a href = "x">` is no tag (the tokenizer re-reads the text after `<`),
    // but the `<b>` after it is: its value is interpolated as text.
    const found = sp103(diagnose(`${vars}:: Start\n<a href = "x"> <b title="{if $x}a{/if}">t</b></a>\n`));
    expect(found.map(at)).toEqual([[5, 25, 38]]);
    expect(runtimeAttributeValues('<a href = "x"> <b title="{if $x}a{/if}">t</b></a>')).toEqual(['{if $x}a{/if}']);
  });

  it('reports nothing for other story formats', () => {
    const story = ':: StoryData\n{"format":"SugarCube"}\n:: Start\n<span class="{if $x}a{/if}">t</span>\n';
    expect(diagnose(story)).toEqual([]);
  });
});
