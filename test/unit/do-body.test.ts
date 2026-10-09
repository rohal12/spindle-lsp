/**
 * `{do}` bodies (Spindle's tokenizer, `RAW_BODY_MACROS`): from 0.50.1 the body
 * up to the first `{/do}` is JavaScript text, so `{name: "x"}` in it is no
 * macro. Before, it is tokenized like any text and `{do}` runs
 * `collectText(children)`, which drops every macro: an object literal that
 * starts with a letter disappears from the code (`Story.defineMacro();`).
 * The installed runtime is the oracle for the side it implements; projects
 * that declare the other version check the other side.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAST } from '../../node_modules/@rohal12/spindle/src/markup/ast.js';
import { tokenize } from '../helpers/tooling.js';
import { collectText } from '../../node_modules/@rohal12/spindle/src/utils/extract-text.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { maskRawDoBodies } from '../../src/core/parsing/macro-parser.js';
import { INSTALLED_CAPABILITIES } from '../helpers/spindle-version.js';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function project(version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'spindle-do-'));
  roots.push(root);
  const pkg = join(root, 'node_modules', '@rohal12', 'spindle');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@rohal12/spindle', version }));
  return root;
}
const uri = 'file:///story.tw';
function codes(version: string | undefined, text: string) {
  const model = new WorkspaceModel(version ? { workspaceRoot: project(version) } : undefined);
  model.initialize(new Map([[uri, text]]));
  const found = computeDiagnostics(uri, model);
  model.dispose();
  return found;
}

const code = 'Story.defineMacro({name: "x", render: () => null});';

describe('do-body: macros inside {do}', () => {
  it('D-runtime: the installed runtime runs the object literal only from 0.50.1', () => {
    const ast = buildAST(tokenize(`{do}${code}{/do}`));
    const run = collectText((ast[0] as { children: never[] }).children);
    expect(run).toBe(INSTALLED_CAPABILITIES.rawDoBodies ? code : 'Story.defineMacro();');
  });

  for (const eol of ['\n', '\r\n']) {
    const story = (body: string) => `:: Start${eol}{do}${eol}${body}${eol}{/do}${eol}`;

    it(`D-before (${JSON.stringify(eol)}): before 0.50.1 the object literal is an unknown macro Spindle drops`, () => {
      for (const version of ['0.45.1', '0.50.0', undefined]) {
        const found = codes(version, story(code)).filter(d => d.code === 'SP100');
        expect(found, String(version)).toHaveLength(1);
        expect(found[0].message).toContain('Unrecognized macro: {name:}');
        expect(found[0].message).toContain('inside {do}');
        expect(found[0].message).toContain('write a space after the brace');
      }
    });

    it(`D-after (${JSON.stringify(eol)}): from 0.50.1 nothing in a {do} body is markup`, () => {
      for (const version of ['0.50.1', '0.51.3']) {
        expect(codes(version, story(code)), version).toEqual([]);
        // not an unclosed container, a link to a missing passage or an unknown macro
        expect(codes(version, story('if (x) { [[Nowhere]]; {if a} {a=b} }')), version).toEqual([]);
      }
    });

    it(`D-control (${JSON.stringify(eol)}): a space after the brace is no macro in any version`, () => {
      for (const version of ['0.45.1', '0.51.3']) {
        expect(codes(version, story('Story.defineMacro({ name: "x", render: () => null });')), version).toEqual([]);
      }
    });

    it(`D-outside (${JSON.stringify(eol)}): macros outside the body and a {do} with no {/do} are ordinary`, () => {
      const outside = `:: Start${eol}{do}x{/do}{a=b}${eol}`;
      expect(codes('0.51.3', outside).map(d => d.message)).toEqual(['Unrecognized macro: {a=b}']);
      const open = `:: Start${eol}{do}{a=b}${eol}`;
      expect(codes('0.51.3', open).map(d => d.code).sort()).toEqual(['SP100', 'SP101']);
    });
  }

  it('D-mask: the body is blanked up to the first {/do}, keeping offsets and line breaks', () => {
    const text = 'a {do}x {b} y\r\nz{/do} {c} {do}{d}{/do}';
    const masked = maskRawDoBodies(text);
    expect(masked).toHaveLength(text.length);
    expect(masked).toBe('a {do}       \r\n {/do} {c} {do}   {/do}');
    expect(maskRawDoBodies('{do}{a}')).toBe('{do}{a}');
  });
});
