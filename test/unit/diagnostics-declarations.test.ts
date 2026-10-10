import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

function diagnose(files: Record<string, string>, uri = 'file:///story.tw') {
  const model = new WorkspaceModel();
  model.initialize(new Map(Object.entries(files).map(([name, text]) => [`file:///${name}`, text])));
  return computeDiagnostics(uri, model);
}

function sp207(text: string) {
  return diagnose({ 'story.tw': text }).filter(d => d.code === 'SP207');
}

describe('SP207: declarations that stop Spindle from starting (#62)', () => {
  it('reports lines of StoryVariables that are not declarations, on the trimmed line', () => {
    const diags = sp207([
      ':: StoryVariables',
      '$gold = 10',
      '  // starting gold',
      '<!-- flags -->',
      '$name =',
      '',
      ':: Start',
      '$gold',
    ].join('\n'));
    expect(diags.map(d => [d.range, d.severity])).toEqual([
      [{ start: { line: 2, character: 2 }, end: { line: 2, character: 18 } }, 'error'],
      [{ start: { line: 3, character: 0 }, end: { line: 3, character: 14 } }, 'error'],
      [{ start: { line: 4, character: 0 }, end: { line: 4, character: 7 } }, 'error'],
    ]);
    expect(diags[0].message).toContain('StoryVariables: Invalid declaration: "// starting gold". Expected: $name = value');
  });

  it('reports values that do not compile, such as a trailing comment', () => {
    const diags = sp207(':: StoryVariables\n$gold = 10 // starting gold\n$ok = "a // b"\n\n:: Start\n$gold $ok');
    expect(diags).toHaveLength(1);
    expect(diags[0].range).toEqual({ start: { line: 1, character: 0 }, end: { line: 1, character: 27 } });
    expect(diags[0].message).toContain('Failed to evaluate "$gold = 10 // starting gold"');
  });

  it('reports unsupported types; null is a valid default', () => {
    const diags = diagnose({
      'story.tw': ':: StoryVariables\n$a = undefined\n$b = null\n$c = {d: null}\n$e = [null]\n\n:: Start\n$a $b $c $e',
    });
    expect(diags.filter(d => d.code === 'SP207').map(d => d.range.start.line)).toEqual([1]);
    expect(diags.filter(d => d.code === 'SP204')).toEqual([]);
  });

  it('checks StoryTransients with its own sigil', () => {
    const diags = sp207(':: StoryVariables\n$a = 1\n\n:: StoryTransients\n%t = 1\n$u = 2\n%v = () => 1\n\n:: Start\n$a %t');
    expect(diags.map(d => d.range.start.line)).toEqual([5, 6]);
    expect(diags[0].message).toContain('StoryTransients: Invalid declaration: "$u = 2". Expected: %name = value');
  });

  it('reports a name declared in both StoryVariables and StoryTransients, on the transient', () => {
    const diags = sp207(':: StoryVariables\n$hp = 1\n\n:: StoryTransients\n  %hp = 2\n%mp = 3\n\n:: Start\n$hp %mp');
    expect(diags).toHaveLength(1);
    expect(diags[0].range).toEqual({ start: { line: 4, character: 2 }, end: { line: 4, character: 5 } });
    expect(diags[0].message).toContain(
      'StoryTransients: Variable "hp" is already declared in StoryVariables. Names must be unique across scopes.',
    );
  });

  it('reports collisions across files, in the file of StoryTransients', () => {
    const files = {
      'vars.tw': ':: StoryVariables\n$hp = 1\n',
      'transients.tw': ':: StoryTransients\n%hp = 2\n',
    };
    expect(diagnose(files, 'file:///transients.tw').filter(d => d.code === 'SP207')).toHaveLength(1);
    expect(diagnose(files, 'file:///vars.tw').filter(d => d.code === 'SP207')).toHaveLength(0);
  });

  it('accepts a name declared twice in one passage, as Spindle does (the later one wins)', () => {
    expect(sp207(':: StoryVariables\n$a = 1\n$a = "x"\n\n:: Start\n$a')).toHaveLength(0);
  });

  it('stops at a line that twee compilers read as the next passage header', () => {
    expect(sp207(':: StoryVariables\n$a = 1\n::NoSpace\nprose here\n\n:: Start\n$a')).toHaveLength(0);
  });

  it('reports nothing for a valid StoryVariables passage', () => {
    expect(sp207([
      ':: StoryVariables',
      '$name = "Bob"',
      '  $gold = 10  ',
      '$when = new Date()',
      '$re = /a\\/\\/b/g',
      '$tpl = `x${1}`',
      '$o = {a: 1, b: [null], c: {d: "e"}}',
      '',
      ':: Start',
      '$name $gold $when $re $tpl $o',
    ].join('\n'))).toEqual([]);
  });
});
