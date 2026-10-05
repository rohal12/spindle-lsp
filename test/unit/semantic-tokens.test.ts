import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import {
  computeSemanticTokensAbsolute,
  computeSemanticTokens,
  encodeTokens,
  tokenTypesLegend,
  tokenModifiersLegend,
} from '../../src/plugins/semantic-tokens.js';

function createWorkspace(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const ws = new WorkspaceModel();
  const contents = new Map<string, string>();
  for (const f of files) {
    contents.set(`file:///${f.name}`, f.content);
  }
  ws.initialize(contents);
  return ws;
}

const typeIdx = (name: string) => tokenTypesLegend.indexOf(name);
const modBit = (name: string) => 1 << tokenModifiersLegend.indexOf(name);

describe('computeSemanticTokensAbsolute', () => {
  it('emits tokens for macro names', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{if $x}hello{/if}',
    });
    const tokens = computeSemanticTokensAbsolute('file:///test.tw', ws);
    const functionTokens = tokens.filter(t => t.tokenType === typeIdx('function'));
    // Should have tokens for 'if' and closing '/if'
    expect(functionTokens.length).toBeGreaterThanOrEqual(2);
  });

  it('emits tokens for story variables with global modifier', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{set $health = 50}',
    });
    const tokens = computeSemanticTokensAbsolute('file:///test.tw', ws);
    const varTokens = tokens.filter(
      t => t.tokenType === typeIdx('variable') && (t.tokenModifiers & modBit('global')) !== 0,
    );
    expect(varTokens.length).toBeGreaterThanOrEqual(1);
  });

  it('emits tokens for passage header namespace', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: MyPassage\nContent',
    });
    const tokens = computeSemanticTokensAbsolute('file:///test.tw', ws);
    const nsTokens = tokens.filter(t => t.tokenType === typeIdx('namespace'));
    // :: token + passage name token
    expect(nsTokens.length).toBeGreaterThanOrEqual(2);
  });

  it('covers escaped brackets and braces in the passage name token', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: A\\[B\ntext\n\n:: C\\{D\\} [tag] {"x": 1}\ntext',
    });
    const tokens = computeSemanticTokensAbsolute('file:///test.tw', ws);
    const nameTokens = tokens
      .filter(t => t.tokenType === typeIdx('namespace') && (t.tokenModifiers & modBit('declaration')) !== 0)
      .map(t => [t.line, t.startChar, t.length]);
    expect(nameTokens).toEqual([[0, 3, 4], [3, 3, 6]]);
  });

  it('emits tokens for sugar keywords', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{if $x is 5}ok{/if}',
    });
    const tokens = computeSemanticTokensAbsolute('file:///test.tw', ws);
    const kwTokens = tokens.filter(t => t.tokenType === typeIdx('keyword'));
    // 'is' should be recognized as a keyword
    expect(kwTokens.length).toBeGreaterThanOrEqual(1);
    expect(kwTokens.some(t => t.length === 2)).toBe(true); // 'is' has length 2
  });

  it('emits tokens for temp and local variables', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{set _temp = 1}\n{@param}',
    });
    const tokens = computeSemanticTokensAbsolute('file:///test.tw', ws);

    const localTokens = tokens.filter(
      t => t.tokenType === typeIdx('variable') && (t.tokenModifiers & modBit('local')) !== 0,
    );
    expect(localTokens.length).toBeGreaterThanOrEqual(1);

    const readonlyTokens = tokens.filter(
      t => t.tokenType === typeIdx('variable') && (t.tokenModifiers & modBit('readonly')) !== 0,
    );
    expect(readonlyTokens.length).toBeGreaterThanOrEqual(1);
  });

  it('emits tokens for transient variables with defaultLibrary modifier', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{set %npcList = []}',
    });
    const tokens = computeSemanticTokensAbsolute('file:///test.tw', ws);
    const transientTokens = tokens.filter(
      t => t.tokenType === typeIdx('variable') && (t.tokenModifiers & modBit('defaultLibrary')) !== 0,
    );
    expect(transientTokens.length).toBeGreaterThanOrEqual(1);
  });

  it('does not emit macro tokens for identifiers inside object literal arguments', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{set $x = {a: 1}, $y = {toString}}',
    });
    const tokens = computeSemanticTokensAbsolute('file:///test.tw', ws);
    const functionTokens = tokens.filter(t => t.tokenType === typeIdx('function'));
    expect(functionTokens).toEqual([
      expect.objectContaining({ line: 1, startChar: 1, length: 3 }),
    ]);
  });
});

describe('encodeTokens', () => {
  it('delta-encodes token positions', () => {
    const tokens = [
      { line: 0, startChar: 5, length: 3, tokenType: 1, tokenModifiers: 0 },
      { line: 0, startChar: 10, length: 4, tokenType: 2, tokenModifiers: 0 },
      { line: 2, startChar: 3, length: 2, tokenType: 1, tokenModifiers: 1 },
    ];
    const encoded = encodeTokens(tokens);
    expect(encoded).toEqual([
      // Token 1: deltaLine=0, deltaStart=5, len=3, type=1, mod=0
      0, 5, 3, 1, 0,
      // Token 2: deltaLine=0, deltaStart=5(=10-5), len=4, type=2, mod=0
      0, 5, 4, 2, 0,
      // Token 3: deltaLine=2, deltaStart=3(absolute since new line), len=2, type=1, mod=1
      2, 3, 2, 1, 1,
    ]);
  });
});

describe('computeSemanticTokens', () => {
  it('returns delta-encoded data array', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{set $x = 1}',
    });
    const data = computeSemanticTokens('file:///test.tw', ws);
    // Should be a flat array of numbers, length divisible by 5
    expect(Array.isArray(data)).toBe(true);
    expect(data.length % 5).toBe(0);
    expect(data.length).toBeGreaterThan(0);
  });
});

describe('CSS-prefixed variable displays (#58)', () => {
  function tokensOn(body: string) {
    const ws = createWorkspace({ name: 'test.tw', content: `:: Start\n${body}` });
    return computeSemanticTokensAbsolute('file:///test.tw', ws).filter(t => t.line === 1);
  }

  it.each([
    ['{.hero-name $player.name}', 12, '$player.name', 'global'],
    ['{#id $var}', 5, '$var', 'global'],
    ['{.a.b#c _temp}', 8, '_temp', 'local'],
    ['{.cls @local}', 6, '@local', 'readonly'],
  ])('tokenizes %s like a plain variable display', (body, startChar, name, modifier) => {
    expect(tokensOn(body)).toEqual([
      {
        line: 1,
        startChar,
        length: name.length,
        tokenType: typeIdx('variable'),
        tokenModifiers: modBit(modifier),
      },
    ]);
  });

  it('marks the macro name after the selectors of a prefixed macro', () => {
    const fn = tokensOn('{.cls#id link "Go" "Next"}').filter(t => t.tokenType === typeIdx('function'));
    expect(fn).toEqual([
      { line: 1, startChar: 9, length: 4, tokenType: typeIdx('function'), tokenModifiers: modBit('defaultLibrary') },
    ]);
  });
});

describe('semantic tokens inside HTML attribute values', () => {
  it('does not mark a macro written inside an attribute value as a macro', () => {
    // Spindle outputs it there as text (SP103).
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n<span class="{if $x}a{/if}">t</span>{if $x}b{/if}',
    });
    const tokens = computeSemanticTokensAbsolute('file:///test.tw', ws);
    const functionTokens = tokens.filter(t => t.tokenType === typeIdx('function'));
    expect(functionTokens.map(t => t.startChar)).toEqual([37, 46]);
  });
});

describe('S80: variable identifiers do not overlap keyword semantic tokens (#80)', () => {
  const uri = 'file:///story.tw';
  const tokensOf = (text: string) => computeSemanticTokensAbsolute(uri, createWorkspace({ name: 'story.tw', content: text }));
  const spans = (text: string, type: string) =>
    tokensOf(text).filter(t => t.tokenType === typeIdx(type)).map(t => [t.line, t.startChar, t.startChar + t.length]);

  function expectNoOverlap(text: string) {
    const tokens = tokensOf(text);
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i].line === tokens[i - 1].line) {
        expect(tokens[i].startChar).toBeGreaterThanOrEqual(tokens[i - 1].startChar + tokens[i - 1].length);
      }
    }
  }

  it('S80: declarations and usages of $is are a single variable token', () => {
    const text = ':: StoryVariables\n$is = 1\n:: Start\n{$is}';
    expectNoOverlap(text);
    expect(spans(text, 'variable')).toEqual([[1, 0, 3], [3, 1, 4]]);
    expect(spans(text, 'keyword')).toEqual([]);
  });

  it('S80-names: other sugar words as variable names and property paths', () => {
    const text = ':: StoryVariables\n$to = 1\n$not = 2\n$o = {"is": 1}\n:: Start\n{if $to is $not and _or is @and}x{/if}{print $o.is}';
    expectNoOverlap(text);
    // only the real operators are keywords: `is`, `and`, `is`
    expect(spans(text, 'keyword')).toEqual([[5, 8, 10], [5, 16, 19], [5, 24, 26]]);
    expect(spans(text, 'variable')).toContainEqual([5, 4, 7]);
  });

  it('S80-operators: real sugar operators in macro arguments stay keywords', () => {
    const text = ':: Start\n{if $a gte 1 and not $b}x{/if}';
    expect(spans(text, 'keyword')).toEqual([[1, 7, 10], [1, 13, 16], [1, 17, 20]]);
    expect(spans(text, 'variable')).toEqual([[1, 4, 6], [1, 21, 23]]);
  });

  it('S80-text: sugar-looking words in prose and strings are not keywords', () => {
    const text = ':: Start\nthis is not a drill, to be or not to be\n{print "this is not it"}{set $x to \'a or b\'}';
    expectNoOverlap(text);
    expect(spans(text, 'keyword')).toEqual([[2, 32, 34]]);
  });

  it('S80-multiline: keywords in multiline macro arguments keep their position', () => {
    const text = ':: Start\n{if $a\n  is 1}x{/if}';
    expect(spans(text, 'keyword')).toEqual([[2, 2, 4]]);
  });
});

describe('S80 gaps: expression contexts for keywords', () => {
  const uri = 'file:///story.tw';
  const tokensOf = (text: string) => computeSemanticTokensAbsolute(uri, createWorkspace({ name: 'story.tw', content: text }));
  const spans = (text: string, type: string) =>
    tokensOf(text).filter(t => t.tokenType === typeIdx(type)).map(t => [t.line, t.startChar, t.startChar + t.length]);
  function expectNoOverlap(text: string) {
    const tokens = tokensOf(text);
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i].line === tokens[i - 1].line) {
        expect(tokens[i].startChar).toBeGreaterThanOrEqual(tokens[i - 1].startChar + tokens[i - 1].length);
      }
    }
  }

  it('S80-decl-control: StoryVariables is plain JavaScript in Spindle 0.45.1 (story-variables.ts uses new Function), not a keyword context', () => {
    const text = ':: StoryVariables\n$a = 1\n$b = "x is y"\n$c = [1, 2]\n:: Start\nx';
    expectNoOverlap(text);
    expect(spans(text, 'keyword')).toEqual([]);
    // the same words in StoryInit are not keywords either (outside macros)
    expect(spans(':: StoryInit\n$a is 1 and $b', 'keyword')).toEqual([]);
  });

  it('S80-template: keywords in ${} interpolations are tokenized, template text is not', () => {
    const text = ':: Start\n{print `this is ${$a is 1 and not $b} or to ${"is"}`}';
    expectNoOverlap(text);
    // `this is`/`or to` are literal text; `"is"` is a nested string
    const line = text.split('\n')[1];
    expect(spans(text, 'keyword').map(([, s, e]) => line.slice(s, e))).toEqual(['is', 'and', 'not']);
    expect(spans(text, 'keyword').map(([, s]) => s)).toEqual([21, 26, 30]);
  });

  it('S80-template-nested: nested templates, braces and strings inside an interpolation', () => {
    const text = ':: Start\n{set $x to `a ${ {k: "or"}.k is `b ${$y and 1} not` } is`}';
    expectNoOverlap(text);
    const line = text.split('\n')[1];
    const words = spans(text, 'keyword').map(([, s, e]) => line.slice(s, e));
    expect(words).toEqual(['to', 'is', 'and']);
  });

  it('S80-template-controls: escaped ${ and unterminated templates stay text', () => {
    expect(spans(':: Start\n{print `a \\${ is } b`}', 'keyword')).toEqual([]);
    expect(spans(':: Start\n{print `no is or not here`}', 'keyword')).toEqual([]);
    expect(spans(':: Start\n{print `a ${$x is 1}`}', 'keyword')).toEqual([[1, 15, 17]]);
    expect(spans(':: Start\n{print `a ${$x is 1} is`}', 'keyword')).toEqual([[1, 15, 17]]);
    // prose around the macro is untouched
    expect(spans(':: Start\nis {print `${1}`} and', 'keyword')).toEqual([]);
  });

  it('S80-template-crlf-utf16: multiline CRLF interpolation and astral characters keep UTF-16 columns', () => {
    const text = ':: Start\r\n{print `\u{1F600} ${$a\r\n  is 1} \u{1F600} and`}\r\nis';
    expectNoOverlap(text);
    expect(spans(text, 'keyword')).toEqual([[2, 2, 4]]);
    const astral = ':: Start\r\n{set $s to `\u{1F600}${$a is 1}` and \u{1F600}}';
    const line = astral.split('\r\n')[1];
    const kw = spans(astral, 'keyword');
    expect(kw.map(([, s, e]) => line.slice(s, e))).toEqual(['to', 'is', 'and']);
    // every range lies within its line
    for (const [l, s, e] of kw) expect(e).toBeLessThanOrEqual(astral.split('\r\n')[l].length);
  });
});
