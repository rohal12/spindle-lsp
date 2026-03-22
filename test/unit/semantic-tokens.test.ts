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
