import { afterEach, describe, expect, it } from 'vitest';
import { parseCode } from '@rohal12/spindle/tooling';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const uri = 'memory:///story.tw';
const models: WorkspaceModel[] = [];
afterEach(() => models.splice(0).forEach(model => model.dispose()));

function warnings(body: string, eol = '\n') {
  const source = `:: StoryVariables\n:: Start\n${body}`.replaceAll('\n', eol);
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(new Map([[uri, source]]));
  const doc = TextDocument.create(uri, 'twee', 0, source);
  const diagnostics = computeDiagnostics(uri, model).filter(d => d.code === 'SP205');
  return { source, doc, diagnostics, covered: diagnostics.map(d => doc.getText(d.range)) };
}

describe('SP205 executable temporary identities (#328)', () => {
  it.each(['. _x', '.\n_x', ' /* before */ . /* after */ _x', '. \\u005fx'])('ignores the assigned member in _obj%s', member => {
    const expression = `_obj${member} = @i`;
    expect(parseCode(expression, 'statements').refs.filter(ref => ref.sigil === '_'))
      .toEqual([expect.objectContaining({ name: 'obj', read: true, write: false })]);
    const body = `{set _obj = {}, _x = 0}{for @i of [1,2]}{set ${expression}}{_x}{/for}`;
    expect(warnings(body).diagnostics).toEqual([]);
  });

  it.each(['. _x', '.\n_x', ' /* before */ . /* after */ _x', '?. _x', '. \\u005fx'])('does not treat the RHS member _obj%s as an accumulator', member => {
    const expression = `_x = _obj${member} + @i`;
    expect(parseCode(expression, 'statements').refs.filter(ref => ref.name === 'x'))
      .toEqual([expect.objectContaining({ sigil: '_', read: false, write: true })]);
    const body = `{set _obj = {_x:0}}{for @i of [1,2]}{set ${expression}}{_x}{/for}`;
    expect(warnings(body).covered).toEqual(['_x']);
  });

  it.each([
    '_x = _\\u0078 + @i',
    '_\\u0078 = _x + @i',
    '_x = `${_\\u0078} ${@i}`',
    '_x = _obj[_x] + @i',
    '_x += @i',
    '_x++',
  ])('keeps genuine accumulators: %s', expression => {
    expect(warnings(`{set _x = 0, _obj = {}}{for @i of [1,2]}{set ${expression}}{_x}{/for}`).diagnostics).toEqual([]);
  });
});

describe.each(['\n', '\r\n'])('SP205 escaped target ranges with EOL %j (#329, #330)', eol => {
  for (const macro of ['set', 'computed']) {
    for (const depth of [0, 1, 2]) {
      it.each([
        ['_x', 'x'],
        ['_\\u0078', 'x'],
        ['_\\u{78}', 'x'],
        ['_x\\u0079', 'xy'],
        ['_x\\u{79}', 'xy'],
      ])(`underlines the complete {${macro}} identifier at label depth ${depth}: %s`, (identifier, name) => {
        expect(parseCode(`${identifier} = @i`, 'statements').refs[0])
          .toMatchObject({ sigil: '_', name, start: 0, end: identifier.length, write: true });
        let body = `{for @i of [1,2]}{${macro} ${identifier} = @i}{_${name}}{/for}`;
        for (let i = 0; i < depth; i++) body = `{button ${JSON.stringify(body)}}x{/button}`;
        const { source, doc, diagnostics, covered } = warnings(body, eol);
        const written = identifier.replaceAll('\\', '\\'.repeat(2 ** depth));
        expect(covered).toEqual([written]);
        expect(diagnostics[0].message).toContain(`Temporary '_${name}'`);
        const start = source.indexOf(written);
        expect(diagnostics[0].range).toEqual({ start: doc.positionAt(start), end: doc.positionAt(start + written.length) });
      });
    }
  }
});

it.each(['set', 'computed'])('keeps escaped %s targets inside deferred bodies out of SP205 (#329)', macro => {
  const body = `{for @i of [1,2]}{button "Pick"}{${macro} _\\u0078 = @i}{/button}{_x}{/for}`;
  expect(warnings(body).diagnostics).toEqual([]);
});

it.each(['@x', '$x', '_x.field', '(_x)', '_x == @i'])('does not infer a computed temporary target from %s (#329)', target => {
  expect(warnings(`{for @i of [1,2]}{computed ${target} = @i}{_x}{/for}`).diagnostics).toEqual([]);
});
