/**
 * Differential test: the LSP's field-access check (SP201) against Spindle's
 * own startup validation, imported from the installed runtime's source.
 * Every field error the LSP reports must be one Spindle reports, with the
 * same message; the only errors the LSP may miss are those whose default is
 * not a literal it can type without evaluating code.
 */
import { describe, it, expect } from 'vitest';
import {
  parseStoryVariables,
  validatePassages,
} from '../../node_modules/@rohal12/spindle/src/story-variables.js';
import { VariableTracker } from '../../src/core/workspace/variable-tracker.js';

const uri = 'file:///story.tw';

/** Spindle's "Cannot access field" errors for a story, without the passage prefix. */
function runtimeErrors(vars: string, passages: Array<[string, string]>): string[] | undefined {
  let schema;
  try {
    schema = parseStoryVariables(vars);
  } catch {
    return undefined; // Spindle refuses the declaration itself
  }
  const map = new Map(passages.map(([name, content]) => [name, { name, tags: [], content } as never]));
  return validatePassages(map, schema)
    .map(e => e.replace(/^Passage "[^"]*": /, ''))
    .filter(e => e.startsWith('Cannot access field'));
}

/** The LSP's SP201 findings for the same story, in Spindle's wording. */
function lspErrors(vars: string, passages: Array<[string, string]>): string[] {
  const text = [':: StoryVariables', vars, '', ...passages.flatMap(([name, content]) => [`:: ${name}`, content, ''])].join('\n');
  const tracker = new VariableTracker();
  tracker.parseStoryVariables(vars, 1, uri);
  tracker.scanDocument(uri, text, []);
  return tracker.getPrimitiveFieldAccesses(uri)
    .map(a => `Cannot access field "${a.field}" on ${a.path} (type: ${a.type})`);
}

const DEFAULTS = [
  '5', '-1.5', '1.', '.5', '1e3', '0x10',
  '"s"', "'s'", '`s`', '`a${1}`', "'it\\'s'", '""',
  'true', 'false',
  '[]', '[1, {a: 1}]', '[{a: "x"}]',
  '{}', '{a: 1}', '{ a : 1 , }',
  '{a: "x", b: [], c: {d: 1, e: {f: true}}}',
  '{"a": {b: 2}}', "{'a': 'q', b: `t`}", '{2: "x", a: {b: {c: {d: 1}}}}',
  '{a: 1, a: {b: 2}}',
  '{...{a: 1}}', '{a: 1, ...{a: {b: 1}}}', '{a: {b: 1}, ...{}}',
  '{get a() { return 1 }}', '{a() { return 1 }}', '{__proto__: {a: 1}}',
  '{["a"]: 1}', '{a: 1 + 1, b: "x"}', '{a: [1].length, b: {c: 1}}', '{a: 10 / 2, b: 1}',
  '2 * 3', '"a" + "b"', 'Math.max(1, 2)', 'new Date()', '[1].length', '({a: 1}).a',
  'String(1)', '!0', 'typeof 1',
];

const PATHS = [
  'a', 'b', 'x', 'length', 'toFixed',
  'a.b', 'a.x', 'b.x', 'b.length', 'c.d', 'c.d.x', 'c.e.f', 'c.e.f.g', 'c.x.y',
  '2.c', '2.length', 'a.b.c', 'a.b.c.d', 'a.b.c.d.e',
];

describe('SP201 agrees with Spindle\'s validatePassages', () => {
  it('reports no field error Spindle does not, across defaults and paths', () => {
    const missed = new Set<string>();
    const rejected = new Set<string>();
    let agreed = 0;
    for (const def of DEFAULTS) {
      for (const path of PATHS) {
        const vars = `$v = ${def}`;
        const passages: Array<[string, string]> = [['Start', `{print $v.${path}}`]];
        const runtime = runtimeErrors(vars, passages);
        if (runtime === undefined) {
          rejected.add(def);
          continue;
        }
        const lsp = lspErrors(vars, passages);
        if (lsp.length > 0) {
          expect({ def, path, lsp }).toEqual({ def, path, lsp: runtime });
          agreed++;
        } else if (runtime.length > 0) {
          missed.add(def);
        }
      }
    }
    expect(agreed).toBeGreaterThan(100);
    expect([...rejected]).toEqual(['{a() { return 1 }}']);
    // Defaults whose value is only known by evaluating them: the LSP stays silent.
    expect([...missed]).toEqual([
      '0x10', '`a${1}`',
      '{...{a: 1}}', '{a: 1, ...{a: {b: 1}}}', '{a: {b: 1}, ...{}}',
      '{get a() { return 1 }}', '{["a"]: 1}', '{a: 1 + 1, b: "x"}', '{a: [1].length, b: {c: 1}}', '{a: 10 / 2, b: 1}',
      '2 * 3', '"a" + "b"', 'Math.max(1, 2)', '[1].length', '({a: 1}).a',
      'String(1)', '!0', 'typeof 1',
    ]);
  });

  it('agrees on whole stories: prose, strings, {for} locals and several passages', () => {
    const vars = [
      '$name = "Bob"',
      '$gold = 10',
      '$flags = []',
      '$player = {hp: 10, stats: {str: 2, title: "Sir"}, bag: []}',
      '$on = false',
    ].join('\n');
    const passages: Array<[string, string]> = [
      ['StoryInit', '{set $player.hp = 12}{set $gold.max = 1}'],
      ['Start', [
        'Hello $name.first, you have $gold.coins coins.',
        '{print "$name.length"} <!-- $on.x --> {print `${$player.stats.title.length}`}',
        '{for @name of $flags}{@name.x} $name.inLoop{/for}',
        '{if $flags.done}{$player.bag.anything.x}{/if} {$player.nope.x}',
        '{textbox "$player.stats.str.v"} \\$on.escaped $5.50',
      ].join('\n')],
      ['Other', '$name.length {$player.stats.str}'],
      ['W [widget]', '{widget "w"}{$on.flag}{/widget}'],
    ];
    const runtime = runtimeErrors(vars, passages.map(([n, c]) => [n.replace(/ \[.*\]$/, ''), c]));
    // The {for @name} in Start makes every $name there a local, as in Spindle.
    expect(runtime).toHaveLength(8);
    expect(lspErrors(vars, passages)).toEqual(runtime);
  });
});
