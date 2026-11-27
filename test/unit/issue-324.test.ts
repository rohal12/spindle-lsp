import { afterEach, expect, it, vi } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'memory:///story.tw';
let model: WorkspaceModel;
afterEach(() => { vi.restoreAllMocks(); model?.dispose(); });

it.each([256, 512])('bounds RHS suffix input for %i assignments in one expression (#324)', count => {
  const expression = Array(count).fill('(_x = 0)').join(' + ');
  const source = `:: StoryVariables\n:: Start\n{for @i of [1,2]}{set ${expression}}{_x}{/for}`;
  model = new WorkspaceModel();
  model.initialize(new Map([[uri, source]]));
  computeDiagnostics(uri, model); // Warm runtime validation and the temporary-read index.
  // Observe the real copying/search input in the local advisory, not elapsed time.
  const slice = String.prototype.slice;
  const test = RegExp.prototype.test;
  let input = 0;
  vi.spyOn(String.prototype, 'slice').mockImplementation(function (this: string, start, end) {
    const result = slice.call(this, start, end);
    if (this === expression) input += result.length;
    return result;
  });
  vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, value) {
    if (this.source.startsWith('(?<![.\\w$@%])_')) input += value.length;
    return test.call(this, value);
  });
  const warnings = computeDiagnostics(uri, model).filter(d => d.code === 'SP205');
  expect(warnings).toHaveLength(1);
  expect(TextDocument.create(uri, 'twee', 0, source).getText(warnings[0].range)).toBe('_x');
  expect(warnings[0].range.start.character).toBe(source.split('\n')[2].lastIndexOf('_x ='));
  expect(input).toBeLessThan(expression.length * 12);
});

it.each([
  ['_x = @i; _y = @i', ['_x', '_y']],
  ['_x = @i, _y = @i', ['_x', '_y']],
  ['_x = (_y = @i, _x + 1)', ['_y']],
  ['(_x = @i) + (_y = @i), _x', ['_x', '_y']],
  ['_x = fn((_y = @i), 0), _x', ['_x', '_y']],
  ['_x = {a: (_y = @i), b: _x}', ['_y']],
  ['_x = _x + @i; _y = @i', ['_y']],
  ['_x = _xx; _y = obj._y', ['_x', '_y']],
  ['_x = $_x; _y = @_y', ['_x', '_y']],
  ['_x = @i /* _x */; _y = @i // _y\n', ['_x', '_y']],
  ['_x = "_x"; _y = /_y/.test("s")', ['_x', '_y']],
  ['_x = `_x ${@i}`; _y = `${_y} ${@i}`', ['_x']],
  ['_x = @i; _x = @i', ['_x', '_x']],
] as const)('preserves RHS accumulator boundaries in %s (#324)', (expression, names) => {
  const source = `:: StoryVariables\r\n:: Start\r\n{for @i of [1,2]}{set ${expression}}{_x}{_y}{/for}`;
  model = new WorkspaceModel();
  model.initialize(new Map([[uri, source]]));
  const doc = TextDocument.create(uri, 'twee', 0, source);
  expect(computeDiagnostics(uri, model).filter(d => d.code === 'SP205').map(d => doc.getText(d.range)))
    .toEqual(names);
});

it('keeps syntax diagnostics when a large set expression exceeds parser limits (#324)', () => {
  const expression = Array(8000).fill('(_x = 0)').join(' + ');
  model = new WorkspaceModel();
  model.initialize(new Map([[uri, `:: StoryVariables\n:: Start\n{for @i of [1,2]}{set ${expression}}{_x}{/for}`]]));
  const codes = computeDiagnostics(uri, model).map(d => d.code);
  expect(codes).toContain('SP106');
  expect(codes.filter(code => code === 'SP205')).toHaveLength(1);
});
