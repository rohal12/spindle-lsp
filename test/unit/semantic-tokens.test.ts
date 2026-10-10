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

  it('does not emit keyword tokens: `is` is a plain identifier in Spindle expressions', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{if $x is 5}ok{/if}',
    });
    const tokens = computeSemanticTokensAbsolute('file:///test.tw', ws);
    expect(tokens.filter(t => t.tokenType === typeIdx('keyword'))).toEqual([]);
    expect(tokens.filter(t => t.tokenType === typeIdx('variable')).map(t => [t.startChar, t.length])).toEqual([[4, 2]]);
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

describe('semantic tokens inside HTML attribute values, labels and comments', () => {
  const tokensOf = (body: string) => computeSemanticTokensAbsolute('file:///test.tw', createWorkspace({ name: 'test.tw', content: `:: Start\n${body}` }));
  const functionStarts = (body: string) => tokensOf(body).filter(t => t.tokenType === typeIdx('function')).map(t => t.startChar);

  it('marks a macro written inside an attribute value: Spindle reads the value as markup', () => {
    expect(functionStarts('<span class="{if $x}a{/if}">t</span>{if $x}b{/if}')).toEqual([14, 23, 37, 46]);
  });

  it('marks a macro and a variable inside the label of a link and of a button', () => {
    const tokens = tokensOf('[[Go {if $x}now{/if}->T]] {button "Press {_k}"}x{/button}');
    expect(tokens.filter(t => t.tokenType === typeIdx('function')).map(t => t.startChar)).toEqual([6, 17, 27, 50]);
    expect(tokens.filter(t => t.tokenType === typeIdx('variable')).map(t => t.startChar)).toEqual([9, 42]);
  });

  it('marks nothing written inside a closed HTML comment: it is one text token', () => {
    expect(tokensOf('<!-- {if $x}a{/if} {$x} {goto "T"} -->').filter(t => t.line === 1)).toEqual([]);
    expect(functionStarts('<!-- {x} -->{if $x}b{/if}')).toEqual([13, 22]);
  });

  it('marks nothing in a {do} body or in a string of code but its variables', () => {
    const tokens = tokensOf('{do}_a = "{if}"{/do}{print "$x {if}"}');
    expect(tokens.filter(t => t.tokenType === typeIdx('function')).map(t => t.startChar)).toEqual([1, 17, 21]);
    expect(tokens.filter(t => t.tokenType === typeIdx('variable')).map(t => t.startChar)).toEqual([4]);
  });
});

describe('S80: variable identifiers never overlap other semantic tokens (#80)', () => {
  const uri = 'file:///story.tw';
  const tokensOf = (text: string) => computeSemanticTokensAbsolute(uri, createWorkspace({ name: 'story.tw', content: text }));
  const spans = (text: string, type: string) =>
    tokensOf(text).filter(t => t.tokenType === typeIdx(type)).map(t => [t.line, t.startChar, t.startChar + t.length]);

  /** The source text of each variable token */
  const varTexts = (text: string) => {
    const lines = text.split(/\r?\n/);
    return spans(text, 'variable').map(([l, s, e]) => lines[l].slice(s, e));
  };

  function expectNoOverlap(text: string) {
    const tokens = tokensOf(text);
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i].line === tokens[i - 1].line) {
        expect(tokens[i].startChar).toBeGreaterThanOrEqual(tokens[i - 1].startChar + tokens[i - 1].length);
      }
    }
  }

  /** Spindle 0.45.1 has no keyword sugar (expression.ts only rewrites sigils): no keyword token anywhere. */
  function expectNoKeywords(text: string) {
    expect(spans(text, 'keyword')).toEqual([]);
  }

  it('S80: declarations and usages of $is are a single variable token', () => {
    const text = ':: StoryVariables\n$is = 1\n:: Start\n{$is}';
    expectNoOverlap(text);
    expect(spans(text, 'variable')).toEqual([[1, 0, 3], [3, 1, 4]]);
    expectNoKeywords(text);
  });

  it('S80-names: sugar-looking words as variable names and property paths are whole variable tokens', () => {
    const text = ':: StoryVariables\n$to = 1\n$not = 2\n$o = {"is": 1}\n:: Start\n{if $to is $not and _or is @and}x{/if}{print $o.is}';
    expectNoOverlap(text);
    expectNoKeywords(text);
    expect(varTexts(text)).toEqual(['$to', '$not', '$o', '$to', '$not', '_or', '@and', '$o.is']);
  });

  it('S80-operators: sugar words in macro arguments are not highlighted (identifiers at runtime)', () => {
    const text = ':: Start\n{if $a gte 1 and not $b}x{/if}';
    expectNoOverlap(text);
    expectNoKeywords(text);
    expect(varTexts(text)).toEqual(['$a', '$b']);
  });

  it('S80-text: sugar-looking words in prose and strings carry no token', () => {
    const text = ':: Start\nthis is not a drill, to be or not to be\n{print "this is not it"}{set $x to \'a or b\'}';
    expectNoOverlap(text);
    expectNoKeywords(text);
    expect(varTexts(text)).toEqual(['$x']);
  });

  it('S80-multiline: variables in multiline macro arguments keep their position', () => {
    const text = ':: Start\n{if $a\n  is $b}x{/if}';
    expectNoOverlap(text);
    expect(varTexts(text)).toEqual(['$a', '$b']);
    expect(spans(text, 'variable')).toEqual([[1, 4, 6], [2, 5, 7]]);
    expectNoKeywords(text);
  });

  it('S80-decl-control: StoryVariables is plain JavaScript in Spindle 0.45.1 (story-variables.ts uses new Function)', () => {
    const text = ':: StoryVariables\n$a = 1\n$b = "x is y"\n$c = [1, 2]\n:: Start\nx';
    expectNoOverlap(text);
    expectNoKeywords(text);
    expectNoKeywords(':: StoryInit\n$a is 1 and $b');
  });

  it('S80-template: variables inside ${} interpolations are tokenized, keyword-looking words are not', () => {
    const text = ':: Start\n{print `this is ${$a is 1 and not $b} or to ${"is"}`}';
    expectNoOverlap(text);
    expectNoKeywords(text);
    expect(varTexts(text)).toEqual(['$a', '$b']);
  });

  it('S80-template-crlf-utf16: CRLF and astral characters keep UTF-16 columns and in-line ranges', () => {
    const text = ':: Start\r\n{print `\u{1F600} ${$a\r\n  is $c} \u{1F600} and`}\r\n{$d}';
    expectNoOverlap(text);
    expectNoKeywords(text);
    const lines = text.split('\r\n');
    const vars = spans(text, 'variable');
    expect(vars.map(([l, s, e]) => lines[l].slice(s, e))).toEqual(['$a', '$c', '$d']);
    const astral = ':: Start\r\n{set $s = `\u{1F600}${$a + 1}` + \u{1F600} + $z}';
    const aLines = astral.split('\r\n');
    const av = spans(astral, 'variable');
    expect(av.map(([l, s, e]) => aLines[l].slice(s, e))).toEqual(['$s', '$a', '$z']);
    for (const [l, s, e] of av) expect(e).toBeLessThanOrEqual(aLines[l].length);
  });
});
