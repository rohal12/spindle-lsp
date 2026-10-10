/**
 * `{do}` bodies (Spindle's tokenizer, `RAW_BODY_MACROS`): the body up to the
 * first `{/do}` is JavaScript text, so `{name: "x"}` in it is no macro, and
 * the macro runs it as statements. Whether the body parses is Spindle's
 * check (`code-syntax`), reported as SP106.
 */
import { describe, expect, it } from 'vitest';
import { passagePieces } from '@rohal12/spindle/tooling';
import { builtinMacros } from '../helpers/tooling.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'file:///story.tw';
function diagnose(text: string) {
  const model = new WorkspaceModel();
  model.initialize(new Map([[uri, text]]));
  const found = computeDiagnostics(uri, model);
  model.dispose();
  return found;
}

const code = 'Story.defineMacro({name: "x", render: () => null});';

describe('do-body: macros inside {do}', () => {
  it('D-runtime: the body of {do} is the statements the macro runs, as written', () => {
    // `passagePieces` says which parts of a passage are code
    const [piece] = passagePieces(`{do}${code}{/do}`, builtinMacros);
    expect(piece).toMatchObject({ kind: 'code', goal: 'statements', label: '{do}' });
    expect(piece.kind === 'code' && piece.code).toBe(code);
  });

  for (const eol of ['\n', '\r\n']) {
    const story = (body: string) => `:: Start${eol}{do}${eol}${body}${eol}{/do}${eol}`;

    it(`D-body (${JSON.stringify(eol)}): nothing in a {do} body is markup`, () => {
      // `{name: "x"}` is an object literal, not an unknown macro
      expect(diagnose(story(code))).toEqual([]);
      // not an unclosed container, a link to a missing passage or an unknown macro
      expect(diagnose(story('if (x) { var s = "[[Nowhere]] {if a} {a=b}"; [[Nowhere]]; }'))).toEqual([]);
    });

    it(`D-syntax (${JSON.stringify(eol)}): JavaScript that does not parse is a code-syntax error (SP106)`, () => {
      const found = diagnose(story('if (x) { {if a} {a=b} }'));
      expect(found.map(d => d.code)).toEqual(['SP106']);
      expect(found[0].severity).toBe('error');
      expect(found[0].range.start.line).toBe(2);
    });

    it(`D-control (${JSON.stringify(eol)}): a space after the brace is no macro either`, () => {
      expect(diagnose(story('Story.defineMacro({ name: "x", render: () => null });'))).toEqual([]);
    });

    it(`D-outside (${JSON.stringify(eol)}): macros outside the body and a {do} with no {/do} are ordinary`, () => {
      const outside = `:: Start${eol}{do}x{/do}{a=b}${eol}`;
      expect(diagnose(outside).map(d => d.message)).toEqual([expect.stringMatching(/^Unknown macro \{a=b\}\./)]);
      const open = `:: Start${eol}{do}{a=b}${eol}`;
      expect(diagnose(open).map(d => d.code).sort()).toEqual(['SP100', 'SP101']);
    });
  }
});
