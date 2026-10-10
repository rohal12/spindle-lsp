import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { documentMacroHeads, macroHeadAt } from '../../src/core/markup/macro-heads.js';

const uri = 'file:///s.tw';
const widgets = ':: W [widget]\n{widget "box"}{@children}{/widget}\n';

function heads(body: string, eol = '\n') {
  const model = new WorkspaceModel();
  model.initialize(new Map([
    ['file:///w.tw', widgets],
    [uri, `:: Start${eol}${body.replace(/\n/g, eol)}`],
  ]));
  const doc = model.markup.get(uri)!;
  const found = documentMacroHeads(doc).map(h => `${h.closing ? '/' : ''}${h.name}@${h.range.start.line}:${h.range.start.character}`);
  return { found, doc, model };
}

describe('macro heads', () => {
  it('are the names of the macros the paired markup runs, closers included', () => {
    const { found, model } = heads('{if $x}{box}a{/box}{else}b{/if}\n{.c box}z{/box}');
    expect(found).toEqual(['if@1:1', 'box@1:8', '/box@1:15', 'else@1:20', '/if@1:28', 'box@2:4', '/box@2:11']);
    model.dispose();
  });

  it('include the macros in labels and attribute values, not those in comments or strings', () => {
    const { found, model } = heads('<p title="{box}x{/box}">a</p> {button "{box}"}b{/button} <!-- {box} --> {print "{box}"}');
    expect(found).toEqual(['box@1:11', '/box@1:18', 'button@1:31', 'box@1:40', '/button@1:49', 'print@1:73']);
    model.dispose();
  });

  it('leave out a closer that closes nothing, but keep that of a container closed over', () => {
    const stray = heads('{/box}{if $x}{/box}{/if}');
    // {/box} closes nothing; the second one is rejected as it crosses {if}
    expect(stray.found).toEqual(['if@1:7']);
    stray.model.dispose();

    const crossed = heads('{box}{if $x}{/box}{/if}');
    // {/box} closes {box}; {if} is left unclosed and its later closer stays with it
    expect(crossed.found).toEqual(['box@1:1', 'if@1:6', '/box@1:14', '/if@1:20']);
    crossed.model.dispose();

    const out = heads('{box}{box}{/box}{/box}');
    expect(out.found).toEqual(['box@1:1', 'box@1:6', '/box@1:12', '/box@1:18']);
    out.model.dispose();
  });

  it('find the head at a position, in LF and CRLF documents', () => {
    for (const eol of ['\n', '\r\n']) {
      const { doc, model } = heads('x\n{box}a{/box}', eol);
      expect(macroHeadAt(doc, { line: 2, character: 1 })).toMatchObject({ name: 'box', closing: false });
      expect(macroHeadAt(doc, { line: 2, character: 4 })).toMatchObject({ name: 'box', closing: false });
      expect(macroHeadAt(doc, { line: 2, character: 5 })).toBeUndefined();
      expect(macroHeadAt(doc, { line: 2, character: 8 })).toMatchObject({ name: 'box', closing: true });
      expect(macroHeadAt(doc, { line: 1, character: 0 })).toBeUndefined();
      model.dispose();
    }
  });
});
