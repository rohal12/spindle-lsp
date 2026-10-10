import { describe, it, expect } from 'vitest';
import { splitWidgetArguments } from '../../src/core/parsing/widget-arguments.js';

function texts(raw: string): string[] {
  return splitWidgetArguments(raw).map(a => a.text);
}

describe('splitWidgetArguments', () => {
  it('keeps grouped expressions and collection literals whole', () => {
    expect(texts('(1 + 2)')).toEqual(['(1 + 2)']);
    expect(texts('[1, 2]')).toEqual(['[1, 2]']);
    expect(texts('{a: 1, b: [2, 3]}')).toEqual(['{a: 1, b: [2, 3]}']);
  });

  it('keeps an operator expression whole', () => {
    expect(texts('$a + 1')).toEqual(['$a + 1']);
    expect(texts('"Chapter " + $n')).toEqual(['"Chapter " + $n']);
  });

  it('splits on top-level commas only', () => {
    expect(texts('$a, ($b, $c), [1, 2]')).toEqual(['$a', '($b, $c)', '[1, 2]']);
    expect(texts('"x, y", fn(1, 2)')).toEqual(['"x, y"', 'fn(1, 2)']);
  });

  it('splits whitespace-separated standalone values', () => {
    expect(texts('"Label" "target"')).toEqual(['"Label"', '"target"']);
    expect(texts('$x $y')).toEqual(['$x', '$y']);
    expect(texts('5 "hits" -1 !$f true (1 + 2)')).toEqual(['5', '"hits"', '-1', '!$f', 'true', '(1 + 2)']);
  });

  it('does not split on whitespace when any token is not a standalone value', () => {
    expect(texts('$x - $y')).toEqual(['$x - $y']);
    expect(texts('Math.max($a, $b) 1')).toEqual(['Math.max($a, $b) 1']);
  });

  it('keeps whitespace inside strings and nesting', () => {
    expect(texts('"a b" (c d)')).toEqual(['"a b"', '(c d)']);
  });

  it('returns no arguments for empty or blank input', () => {
    expect(texts('')).toEqual([]);
    expect(texts('   ')).toEqual([]);
  });

  it('keeps empty comma-separated slots like Spindle', () => {
    expect(texts('1,,2')).toEqual(['1', '', '2']);
    expect(texts('1,')).toEqual(['1']);
  });

  it('reports offsets of the trimmed arguments', () => {
    const raw = '  $a ,  [1, 2] ';
    expect(splitWidgetArguments(raw).map(a => [a.start, a.end])).toEqual([[2, 4], [8, 14]]);
    const ws = ' 5   "hits"';
    expect(splitWidgetArguments(ws).map(a => [a.start, a.end])).toEqual([[1, 2], [5, 11]]);
  });
});
