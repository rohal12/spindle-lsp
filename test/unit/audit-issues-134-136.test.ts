import { afterEach, expect, it } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { findPassageReferences } from '../../src/plugins/references.js';
import { openPlaySession } from '@rohal12/spindle/play';

const uri = 'file:///story.tw';
const models: WorkspaceModel[] = [];
function workspace(files: Array<[string, string]>) {
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map(files));
  return model;
}
afterEach(() => models.splice(0).forEach(model => model.dispose()));

it('accepts array-index displays that the public runtime renders for both variable scopes (#134)', async () => {
  const variables = '$arr = ["hello", "world"]\n$rows = [{name: "Ada"}]';
  const transients = '%queue = ["one", "two"]';
  const displays = '{$arr.0} {$arr.1} {$rows.0.name} {%queue.0} {%queue.1}';
  const session = await openPlaySession({ html: `<tw-storydata name="Array indices" ifid="A134" startnode="3">
    <tw-passagedata pid="1" name="StoryVariables">${variables}</tw-passagedata>
    <tw-passagedata pid="2" name="StoryTransients">${transients}</tw-passagedata>
    <tw-passagedata pid="3" name="Start">${displays}</tw-passagedata>
  </tw-storydata>` });
  try {
    expect(await session.observe()).toMatchObject({ text: 'hello world Ada one two', errors: [] });
  } finally { await session.close(); }
  const model = workspace([[uri, [
    ':: StoryVariables', variables,
    ':: StoryTransients', transients,
    ':: Start', displays,
    '{$arr.missing} {%queue.missing}',
  ].join('\n')]]);
  const found = computeDiagnostics(uri, model).filter(d => d.code === 'SP206');
  expect(found.map(d => d.range)).toEqual([
    { start: { line: 7, character: 1 }, end: { line: 7, character: 13 } },
    { start: { line: 7, character: 16 }, end: { line: 7, character: 30 } },
  ]);
});

for (const reverse of [false, true]) {
  it(`uses the effective widget's arity regardless of ingestion order (${reverse}, #136)`, () => {
    const definitions: Array<[string, string]> = [
      ['file:///z.tw', ':: Z [widget]\n{widget "card" @x}Z{/widget}\n'],
      ['file:///a.tw', ':: A [widget]\n{widget "card"}A{/widget}\n'],
    ];
    const model = workspace([...(reverse ? definitions.reverse() : definitions), [uri, ':: StoryVariables\n:: Start\n{card "x"}\n{card}\n']]);
    expect(model.widgets.getWidget('card')?.uri).toBe('file:///z.tw');
    expect(getDefinition(uri, { line: 2, character: 3 }, model)?.uri).toBe('file:///z.tw');
    expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP301').map(d => [d.range.start.line, d.message]))
      .toEqual([[3, 'Widget {card} expects 1 argument(s), got 0']]);
  });

  it(`uses the effective widget's passage roles (${reverse}, #136)`, () => {
    const definitions: Array<[string, string]> = [
      ['file:///z.tw', ':: Z [widget]\n{widget "card" @target:passage}{@target}{/widget}\n'],
      ['file:///a.tw', ':: A [widget]\n{widget "card" @text}{@text}{/widget}\n'],
    ];
    const model = workspace([...(reverse ? definitions.reverse() : definitions), [uri, ':: StoryVariables\n:: Start\n{card "Missing"}\n']]);
    expect(findPassageReferences('Missing', model, false)).toHaveLength(1);
    expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP300').map(d => d.message))
      .toEqual(['No passage named "Missing" in {card "Missing"}.']);
  });
}

it.each([
  ['string | (string &+ number)', '"hello" 1'],
  [String.raw`'a"b'`, String.raw`"a\"b"`],
])('accepts configured macro calls with schema %s through diagnostics (#135, #137)', (schema, args) => {
  const model = workspace([
    [uri, `:: StoryVariables\n:: Start\n{custom ${args}}\n`],
    ['file:///macros.js', 'Story.defineMacro({name:"custom",parameters:[{name:"value",type:"string",required:true},{name:"count",type:"number"}],render(){return null;}});'],
  ]);
  model.macros.loadConfig({ custom: { parameters: [schema] } });
  expect(computeDiagnostics(uri, model).filter(d => d.severity === 'error')).toEqual([]);
});

it('preserves unrelated diagnostics after a call with overlapping repeated alternatives (#135)', () => {
  const args = [...Array(11).fill('"x"'), '1'].join(' ');
  const model = workspace([[uri, `:: StoryVariables\n:: Start\n{complex ${args}}\n{simple "wrong"}\n`]]);
  model.macros.loadConfig({
    complex: { parameters: ['...(string | (string &+ string)) &+ bool', '...string &+ number'] },
    simple: { parameters: ['number'] },
  });
  expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP109').map(d => d.message))
    .toEqual(['{simple}: Argument is not a number']);
});
