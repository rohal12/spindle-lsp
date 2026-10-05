/**
 * Differential test: the LSP's StoryVariables / StoryTransients checks (SP207,
 * and SP204 for null) against Spindle's own parseStoryVariables(), imported
 * from the installed runtime's source. Every line the LSP flags must be one
 * Spindle rejects; the lines Spindle rejects that the LSP misses are listed.
 */
import { describe, it, expect } from 'vitest';
import { parseStoryVariables } from '../../node_modules/@rohal12/spindle/src/story-variables.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

type Sigil = '$' | '%';
const PASSAGE = { '$': 'StoryVariables', '%': 'StoryTransients' } as const;

/**
 * The passage text Spindle reads: twee compilers turn CRLF and CR into LF,
 * and Spindle reads passages with innerHTML, which writes a no-break space
 * as `&nbsp;` (its entity decoding leaves that one alone).
 */
function compiled(content: string): string {
  return content.replace(/\r\n?/g, '\n').replace(/\u00a0/g, '&nbsp;');
}

/** Spindle's error for a passage, or undefined if it accepts it. */
function runtimeError(content: string, sigil: Sigil): string | undefined {
  try {
    parseStoryVariables(compiled(content), sigil);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/** The SP207 / SP204 diagnostics for a passage, by line of its content. */
function lspFindings(content: string, sigil: Sigil): Map<number, string> {
  const text = `:: ${PASSAGE[sigil]}\n${content}\n\n:: Start\nHello`;
  const model = new WorkspaceModel();
  model.initialize(new Map([['file:///story.tw', text]]));
  const findings = new Map<number, string>();
  for (const d of computeDiagnostics('file:///story.tw', model)) {
    if (d.code === 'SP207' || d.code === 'SP204') findings.set(d.range.start.line - 1, d.message);
  }
  return findings;
}

const VALUES = [
  // Accepted
  '1', '-1.5', '.5', '1e3', '0x10', '0777', '08', '1_000', 'NaN', 'Infinity', 'true', 'false',
  '"s"', "'s'", '`s`', '`t${1}`', '"http://example.com"', '"a // b"', "'x = 1'", '"<!-- -->"', '`a // b`',
  '"semi;colon"', '[]', '[1, "a", {b: 2}]', '[null]', '[undefined]', '[() => 1]', '{}', '{a: 1}', '{a: {b: [1]}}',
  '{"a": 1, \'b\': 2}', '{a: null, a: 1}', '{a: undefined, a: 1}', '{__proto__: {}}', '/ab+c/gi', '/a\\/\\/b/',
  '/[/]/', 'new Date()', 'new Map()', 'Math.max(1, 2)', '1 + 2', '"a" + "b"', '1, 2', '1) || (2', '(1)',
  '1 /* note */', '/* note */ 1', 'typeof x', '[1].length', '({a: 1}).a', '{a: 1}.a', '!0', 'null ?? 1',
  'undefined || 0', '(() => 1)()', 'function () { return 1 }()', 'void 0 || 1', 'String(1)', 'Symbol.iterator.description',
  '"é"', '"\u00a0"', 'Object.create(null)', '{toString: 1}', '{"__proto__": {}}', '{0: 1, 1: "x"}',
  // Rejected
  'null', '{a: null}', '{a: {b: null}}', '{a: null, b: 1}', '(null)', 'undefined', 'void 0', '{a: undefined}',
  '() => 1', 'x => x', 'async () => 1', 'function () {}', 'function* g() {}', 'class {}', 'class A {}',
  '{a: () => 1}', '{a: function () {}}', '1n', '-1n', '0x1fn', '{a: 1n}', '+1n', 'Symbol()', '{f() {}}',
  '{get a() { return null }}', '{...{a: null}}', '{["a"]: null}', 'Math.max', 'x => x / 2', 'Object', '1n + 1',
  'foo', 'foo()', 'missing.field', '1 // note', '1 <!-- note', '[1, // note', '"a" // "b"', '1 /* note',
  '1;', '1; 2', '(1', '1)', '[1,', '{', '{a: 1', '"unterminated', "'unterminated", '`unterminated', '= 1',
  '> 1', '1 +', 'return 1', 'if (x) 1', 'let x = 1', '@', '#x', '1 --> c', '/unterminated', '\u00a01',
];

const NAMES = ['a', '5', '_', 'camelCase', 'snake_case', 'é', 'a-b', 'a.b', 'a$b'];

const LINES = [
  ...VALUES.map(v => `$a = ${v}`),
  ...NAMES.map(n => `$${n} = 1`),
  '', '   ', '\t', '$a=1', '  $a = 1  ', '\t$a\t=\t1\t', '$a  =  1', '$a = 1\r', '$a\u00a0= 1',
  '$a =', '$a = ', '$a == 1', '$a => 1', '$a =  // note', '$ a = 1', 'a = 1', '$a', '$', '= 1', '$$a = 1',
  '$a$b = 1', '%a = 1', '// comment', '/* comment */', '<!-- comment -->', '# heading', 'Some prose.',
  '{set $a = 1}', '$a = 1 \r 2', '\u00a0$a = 1', '$a = 1\u00a0', '$a = 1\u2028', '$a = 1\u2028 2',
];

describe('SP207 / SP204 agree with Spindle\'s parseStoryVariables', () => {
  for (const sigil of ['$', '%'] as const) {
    it(`flags only lines Spindle rejects, line by line (${PASSAGE[sigil]})`, () => {
      const missed: string[] = [];
      let flagged = 0;
      for (const template of LINES) {
        // The same lines with the passage's own sigil, and the other one.
        const line = sigil === '$' ? template : template.replace(/[$%]/g, c => (c === '$' ? '%' : '$'));
        const runtime = runtimeError(line, sigil);
        const lsp = lspFindings(line, sigil).get(0);
        if (lsp !== undefined) {
          flagged++;
          expect({ line, runtime }).toEqual({ line, runtime: expect.any(String) });
          if (lsp.startsWith(PASSAGE[sigil])) {
            // SP207 quotes Spindle's message (adding the field of a nested value).
            expect(lsp.replace(/ \([$%][\w.]+\)/, '')).toContain(runtime);
          }
        } else if (runtime !== undefined) {
          missed.push(line);
        }
      }
      expect(flagged).toBeGreaterThan(60);
      const swap = (s: string) => (sigil === '$' ? s : s.replace(/[$%]/g, c => (c === '$' ? '%' : '$')));
      // Rejected only when evaluated, or not certainly rejected by reading the text.
      expect(missed).toEqual([
        '(null)', '+1n', 'Symbol()', '{f() {}}', '{get a() { return null }}', '{...{a: null}}',
        '{["a"]: null}', 'Math.max', 'x => x / 2', 'Object', '1n + 1', 'foo', 'foo()', 'missing.field',
        '/unterminated', '\u00a01',
      ].map(v => swap(`$a = ${v}`)).concat([
        '$a\u00a0= 1', '$a = 1 \r 2', '\u00a0$a = 1', '$a = 1\u00a0',
      ].map(swap)));
    });
  }

  it('reads each line on its own: values do not continue on the next line', () => {
    const content = '$a = [1,\n2]\n$b = {\n  c: 1\n}\n$d = 1';
    expect(runtimeError(content, '$')).toMatch(/Failed to evaluate "\$a = \[1,"/);
    expect([...lspFindings(content, '$').keys()]).toEqual([0, 1, 2, 3, 4]);
    for (const line of content.split('\n').slice(0, 5)) expect(runtimeError(line, '$')).toBeDefined();
  });

  it('agrees on whole passages, CRLF and indentation included', () => {
    const passages = [
      '$name = "Bob"\r\n$gold = 10\r\n\r\n  $flags = []  \r\n',
      '\t$a = 1\n\n\t$b = {c: "d // e"}\n',
      '$a = 1\n$a = "again"\n',
      '$a = 1\r\n// players start with 1\r\n',
      '$a = 1 // players start with 1\n$b = 2',
      '$a = 1\n$b = undefined\n$c = 3',
      '$when = new Date()\n$re = /x\\/y/\n$tpl = `${"a"}b`',
    ];
    for (const content of passages) {
      const flagged = lspFindings(content, '$').size > 0;
      expect({ content, rejected: runtimeError(content, '$') !== undefined }).toEqual({ content, rejected: flagged });
    }
  });

  it('reports a name in both passages as Spindle\'s startup does', () => {
    // index.tsx (boot): after parsing both passages, a transient name that
    // StoryVariables declares is a startup error.
    const collisions = (vars: string, transients: string): string[] => {
      const schema = parseStoryVariables(vars);
      return [...parseStoryVariables(transients, '%').keys()].filter(name => schema.has(name));
    };
    const vars = '$hp = 1\n$mp = 2\n$5 = 0';
    const transients = '%hp = 3\n%xp = 4\n%5 = 1\n%hp = 5';
    expect(collisions(vars, transients)).toEqual(['hp', '5']);

    const model = new WorkspaceModel();
    model.initialize(new Map([['file:///story.tw', `:: StoryVariables\n${vars}\n\n:: StoryTransients\n${transients}\n`]]));
    const lsp = computeDiagnostics('file:///story.tw', model)
      .filter(d => d.code === 'SP207')
      .map(d => /Variable "(\w+)" is already declared/.exec(d.message)?.[1]);
    expect(lsp).toEqual(['hp', '5']);
  });
});
