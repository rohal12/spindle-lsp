/**
 * Checks SP103 and its quick fixes against Spindle's own tokenizer and
 * interpolate(), imported from the installed runtime's source. The store is
 * stubbed: interpolate() only reads it for visited() and similar functions.
 */
import { describe, it, expect, vi } from 'vitest';
import { hasInterpolation, interpolate } from '../../node_modules/@rohal12/spindle/src/interpolation.js';
import { tokenize } from '../../node_modules/@rohal12/spindle/src/markup/tokenizer.js';
import { evaluate } from '../../node_modules/@rohal12/spindle/src/expression.js';
import { conditionalExpression, findUnevaluatedBlocks, printExpression } from '../../src/core/parsing/attribute-blocks.js';
import { scanHtmlTags } from '../../src/core/parsing/html-scanner.js';

vi.mock('../../node_modules/@rohal12/spindle/src/store.ts', () => ({
  useStoryStore: {
    getState: () => ({ visitCounts: {}, renderCounts: {}, currentPassage: 'Start' }),
  },
}));

interface Scope {
  variables?: Record<string, unknown>;
  temporary?: Record<string, unknown>;
  locals?: Record<string, unknown>;
  transient?: Record<string, unknown>;
}

/**
 * The attributes of the first element Spindle's tokenizer reads in `markup`,
 * rendered the way HtmlNodeRenderer does (useInterpolate: values without a
 * `{sigil…}` block are kept as they are).
 */
function renderAttributes(markup: string, scope: Scope = {}): Record<string, string> {
  const tag = tokenize(markup).find(t => t.type === 'html');
  if (!tag || tag.type !== 'html') throw new Error(`no tag in ${markup}`);
  const rendered: Record<string, string> = {};
  for (const [name, value] of Object.entries(tag.attributes)) {
    rendered[name] = hasInterpolation(value)
      ? interpolate(value, scope.variables ?? {}, scope.temporary ?? {}, scope.locals ?? {}, scope.transient ?? {})
      : value;
  }
  return rendered;
}

const MACROS = new Set(['if', 'else', 'elseif', 'for', 'print', 'set', 'switch', 'case', 'do']);
const CONTAINERS = new Set(['if', 'for', 'switch', 'do']);
const lookup = {
  isMacro: (name: string) => MACROS.has(name),
  isContainer: (name: string) => CONTAINERS.has(name),
};

const scope: Scope = {
  variables: { n: 1, s: 'a', x: false, o: { k: 2 } },
  temporary: { t: 3 },
  locals: { d: { delta: 1 } },
  transient: { tr: 4 },
};

describe('SP103 against Spindle', () => {
  // Attribute values written with double quotes
  const values = [
    '{if @d.delta > 0}delta-positive{else}delta-negative{/if}',
    'card {if $x}active{/if} wide',
    '{if $n}{if _t}a{/if}{/if}',
    '{print $n}',
    '{for _i range 3}x{/for}',
    '{else}',
    '{/if}',
    "{!$n ? 'zero' : 'nonzero'}",
    '{($n + 1)}',
    '{Math.max($n, 0)}',
    "{'x' + $s}",
    '{ $n}',
    '{.c if $x}a{/if}',
    '{$n} {_t} {@d.delta} {%tr}',
    "{$n > 0 ? 'pos' : 'neg'}",
    '{{$n}}',
    "{'a': 1}",
    '{name} {} a{color:red}',
    "{$o.k} and {if $n}x{/if}",
  ];

  it('reads attribute values as the tokenizer does', () => {
    for (const value of values) {
      const markup = `<span class="${value}">t</span>`;
      const tag = scanHtmlTags(markup).tags[0];
      const [start, end] = tag.values![0];
      expect(markup.slice(start, end)).toBe((tokenize(markup)[0] as { attributes: Record<string, string> }).attributes.class);
    }
  });

  it('flags only blocks that Spindle outputs as written', () => {
    let flagged = 0;
    for (const value of values) {
      const rendered = renderAttributes(`<span class="${value}">t</span>`, scope).class;
      for (const block of findUnevaluatedBlocks(value, lookup)) {
        flagged++;
        const source = value.slice(block.start, block.end);
        expect({ value, rendered: rendered.includes(source) }).toEqual({ value, rendered: true });
      }
    }
    expect(flagged).toBe(14);
  });

  it('does not flag blocks Spindle evaluates', () => {
    const evaluated = ['{$n} {_t} {@d.delta} {%tr}', "{$n > 0 ? 'pos' : 'neg'}", '{{$n}}'];
    for (const value of evaluated) {
      expect(findUnevaluatedBlocks(value, lookup)).toEqual([]);
      expect(renderAttributes(`<span class="${value}">t</span>`, scope).class).not.toBe(value);
    }
  });
});

describe('SP103 quick fix against Spindle', () => {
  // [attribute value, scope where the condition holds, where it does not, expected when true, when false]
  const cases: Array<[string, string, Scope, Scope, string, string]> = [
    ['"', '{if @d.delta > 0}delta-positive{else}delta-negative{/if}',
      { locals: { d: { delta: 1 } } }, { locals: { d: { delta: 0 } } }, 'delta-positive', 'delta-negative'],
    ['"', 'card {if $x}active{/if}', { variables: { x: true } }, { variables: { x: false } }, 'card active', 'card '],
    ["'", '{if $s == "a"} on{else}off {/if}', { variables: { s: 'a' } }, { variables: { s: 'b' } }, ' on', 'off '],
    ['"', "{if _t}it's{else}a\\b{/if}", { temporary: { t: 1 } }, { temporary: { t: 0 } }, "it's", 'a\\b'],
    ["'", '{if %tr}say "hi"{/if}', { transient: { tr: 1 } }, { transient: { tr: 0 } }, 'say "hi"', ''],
    ['"', '{if $a?.b ?? $c >= 1}yes{else}no{/if}',
      { variables: { a: { b: 1 }, c: 0 } }, { variables: { a: null, c: 0 } }, 'yes', 'no'],
    ['"', '{if $n}cost $y and 50%{else}_t @l %tr{/if}',
      { variables: { n: 1, y: 'Y' } }, { variables: { n: 0 }, temporary: { t: 'T' } }, 'cost $y and 50%', '_t @l %tr'],
  ];

  it('produces a block Spindle evaluates to the branch the macro meant', () => {
    for (const [quote, value, whenTrue, whenFalse, expectTrue, expectFalse] of cases) {
      const blocks = findUnevaluatedBlocks(value, lookup);
      expect(blocks).toHaveLength(1);
      const { start, end } = blocks[0];
      const fix = conditionalExpression(value.slice(start, end));
      expect(fix, value).not.toBeNull();
      const fixed = value.slice(0, start) + fix + value.slice(end);
      const markup = `<span class=${quote}${fixed}${quote}>t</span>`;
      expect({ fixed, rendered: renderAttributes(markup, whenTrue).class })
        .toEqual({ fixed, rendered: expectTrue });
      expect({ fixed, rendered: renderAttributes(markup, whenFalse).class })
        .toEqual({ fixed, rendered: expectFalse });
      // The fixed value has nothing left to report
      expect(findUnevaluatedBlocks(fixed, lookup)).toEqual([]);
    }
  });
});

describe('SP103 {print} quick fix against Spindle', () => {
  /** What {print E} displays (Print.tsx): String(evaluate(E)), '' for null and undefined. */
  function printDisplay(expr: string, scope: Scope): string {
    try {
      const value = evaluate(expr, scope.variables ?? {}, scope.temporary ?? {}, scope.locals ?? {}, scope.transient ?? {});
      return value == null ? '' : String(value);
    } catch {
      return 'ERROR';
    }
  }

  function rendered(markup: string, scope: Scope): string {
    try {
      return renderAttributes(markup, scope).class;
    } catch {
      return 'ERROR';
    }
  }

  // [attribute quote, value, scopes to render it in]
  const cases: Array<[string, string, Scope[]]> = [
    ['"', "d {print @delta > 0 ? 'delta-positive' : 'delta-negative'}",
      [{ locals: { delta: 1 } }, { locals: { delta: -1 } }]],
    ['"', '{print $x}', [0, false, null, undefined, '', 'str', [1, 2], { a: 1 }].map(x => ({ variables: { x } }))],
    ['"', 'n-{print $s.length}', [{ variables: { s: 'abc' } }, { variables: { s: [1] } }]],
    ['"', '{print $o.k}', [{ variables: { o: { k: null } } }, { variables: { o: { k: 0 } } }, { variables: { o: {} } }]],
    ['"', '{print @d.delta}', [{ locals: { d: { delta: 2 } } }]],
    ['"', '{print _t} {print %t * 2}', [{ temporary: { t: 'T' }, transient: { t: 3 } }]],
    ['"', '{print $a.slice(0, 2).join(", ")}', [{ variables: { a: [1, 2, 3] } }]],
    ["'", `{print $s == "a" ? 'yes' : 'no'}`, [{ variables: { s: 'a' } }, { variables: { s: 'b' } }]],
    ['"', "{print $a + ';'}", [{ variables: { a: 'x' } }]],
    ['"', '{print $m[1, 2]}', [{ variables: { m: [10, 20, 30] } }]],
  ];

  it('produces blocks Spindle evaluates to what {print} displays', () => {
    let checked = 0;
    for (const [quote, value, scopes] of cases) {
      let fixed = value;
      // Rewrite each {print} block, from the last one back
      const blocks = findUnevaluatedBlocks(value, lookup);
      expect(blocks.length, value).toBeGreaterThan(0);
      const parts: Array<(scope: Scope) => string> = [];
      let rest = value;
      for (const { start, end } of [...blocks].reverse()) {
        const source = rest.slice(start, end);
        const fix = printExpression(source);
        expect(fix, source).not.toBeNull();
        const expr = /^\{print\s+(.*)\}$/.exec(source)![1];
        const tail = rest.slice(end);
        parts.unshift(scope => printDisplay(expr, scope) + tail);
        fixed = fixed.slice(0, start) + fix + fixed.slice(end);
        rest = rest.slice(0, start);
      }
      const head = rest;
      const expected = (scope: Scope) => head + parts.map(p => p(scope)).join('');
      for (const scope of scopes) {
        const markup = `<span class=${quote}${fixed}${quote}>t</span>`;
        expect({ fixed, scope, rendered: rendered(markup, scope) })
          .toEqual({ fixed, scope, rendered: expected(scope) });
        checked++;
      }
      expect(findUnevaluatedBlocks(fixed, lookup)).toEqual([]);
    }
    expect(checked).toBe(22);
  });

  it("needs {E ?? ''} for a dotted path: 0.45.1 reads a primitive's property as ''", () => {
    // resolveSimple() handles {$s.length} without the evaluator; upstream
    // main boxes primitives and renders 3.
    expect(renderAttributes('<span class="{$s.length}">t</span>', { variables: { s: 'abc' } }).class).toBe('');
  });
});
