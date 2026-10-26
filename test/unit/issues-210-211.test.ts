import { afterEach, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { compile, parseTwee, StoryBuilder } from '@rohal12/twee-ts';
import { openPlaySession } from '@rohal12/spindle/play';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { formatDocument, formatRange } from '../../src/plugins/format.js';

const uri = 'file:///story.tw';
const metadata = ':: StoryTitle\nGame\n:: StoryData\n{"ifid":"7E95B777-0E72-4603-AA57-049388D05756","format":"Spindle"}\n';
const models: WorkspaceModel[] = [];
afterEach(() => models.splice(0).forEach(model => model.dispose()));
function workspace(text: string, extra: Array<[string, string]> = []) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, text], ...extra]));
  return model;
}
const warnings = (model: WorkspaceModel) => computeDiagnostics(uri, model).filter(d => d.code === 'SP206');

for (const eol of ['\n', '\r\n']) {
  it.each(['script', 'stylesheet', 'script stylesheet'])(
    `preserves compiler metadata ahead of %s tags, EOL ${JSON.stringify(eol)} (#210)`, async tags => {
      const source = `:: StoryT\\itle [${tags}]\nGame\n:: StoryData [${tags}]\n{"format":"Spindle"}\n:: Start\nHi\n`.replaceAll('\n', eol);
      for (const output of [await formatDocument(source), await formatRange(source, { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } })]) {
        const builder = new StoryBuilder();
        const diagnostics: Parameters<StoryBuilder['add']>[1] = [];
        for (const passage of parseTwee(output).passages) builder.add(passage, diagnostics);
        expect(diagnostics.filter(d => d.level === 'error')).toEqual([]);
        expect(builder.build().name).toBe('Game');
        expect(builder.build().twine2.format).toBe('Spindle');
        expect(output).toBe(source);
      }
    },
  );
}

for (const sigil of ['$', '%']) {
  it(`does not claim a replaced ${sigil} array default has an undefined member (#211)`, async () => {
    const source = `${metadata}:: StoryVariables\n${sigil === '$' ? '$arr = []\n' : ''}:: StoryTransients\n${sigil === '%' ? '%arr = []\n' : ''}:: Start\n{set ${sigil}arr = {foo:7}}{${sigil}arr.foo}\n`;
    const result = await compile({
      sources: [{ filename: uri, content: source }], formatId: 'pkg',
      formatPaths: [fileURLToPath(new URL('../../node_modules/@rohal12/spindle/dist/', import.meta.url))],
      noRemote: true, useTweegoPath: false,
    });
    expect(result.diagnostics.filter(d => d.level === 'error')).toEqual([]);
    const session = await openPlaySession({ html: result.output, trusted: true });
    try {
      const observed = await session.observe();
      expect(observed.errors).toEqual([]);
      expect(observed.text).toBe('7');
    } finally { await session.close(); }
    const model = workspace(source);
    expect(warnings(model)).toEqual([]);
    model.documents.update(uri, source.replace(`{set ${sigil}arr = {foo:7}}`, ''));
    expect(warnings(model)).toHaveLength(1);
  });
}

it.each([
  '{set $arr = {foo:7}}',
  '{do}$arr = {foo:7};{/do}',
  '{do}({arr: $arr} = {arr: {foo:7}});{/do}',
  '{print ($arr = {foo:7})}',
  '<button onclick="{$arr = {foo:7}}">change</button>',
  '{button "{set $arr = {foo:7}}change"}go{/button}',
])('invalidates array assumptions for executable root writes: %s (#211)', assignment => {
  const source = `${metadata}:: StoryVariables\n$arr = []\n:: Start\n{$arr.foo}\n`;
  const other = 'file:///other.tw';
  const model = workspace(source, [[other, `:: Setter\n${assignment}\n`]]);
  expect(warnings(model)).toEqual([]);
  model.documents.update(other, ':: Setter\nNo assignment\n');
  expect(warnings(model)).toHaveLength(1);
  model.documents.update(other, `:: Setter\n${assignment}\n`);
  expect(warnings(model)).toEqual([]);
  model.documents.close(other);
  expect(warnings(model)).toHaveLength(1);
});

it.each([
  '{set $arr.length = 0}',
  '{print "$arr = {foo:7}"}',
  '<!-- {set $arr = {foo:7}} -->',
  '{set $other = {foo:7}}',
])('retains unchanged-array warnings with %s (#211)', code => {
  const model = workspace(`${metadata}:: StoryVariables\n$arr = []\n$other = []\n:: Start\n${code}{$arr.foo}\n`);
  expect(warnings(model)).toHaveLength(1);
});
