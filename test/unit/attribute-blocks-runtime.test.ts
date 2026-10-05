/**
 * Checks SP103 against Spindle's own tokenizer and interpolate(), imported
 * from the installed runtime's source. The store is stubbed: interpolate()
 * only reads it for visited() and similar functions.
 */
import { describe, it, expect, vi } from 'vitest';
import { hasInterpolation, interpolate } from '../../node_modules/@rohal12/spindle/src/interpolation.js';
import { tokenize } from '../../node_modules/@rohal12/spindle/src/markup/tokenizer.js';
import { findUnevaluatedBlocks } from '../../src/core/parsing/attribute-blocks.js';
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
