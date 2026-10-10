import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import type { PassageMarkup } from '../core/markup/passage-markup.js';
import { macroTokens, variableUses, type VariableUse } from './markup-symbols.js';

// ---------------------------------------------------------------------------
// Token legend
// ---------------------------------------------------------------------------

export const tokenTypesLegend: string[] = [
  'function', 'variable', 'parameter', 'property', 'keyword',
  'string', 'number', 'comment', 'namespace', 'type',
  'macro', 'regexp',
];

export const tokenModifiersLegend: string[] = [
  'declaration', 'defaultLibrary', 'global', 'local', 'readonly',
];

const tokenTypeIndex = new Map<string, number>(
  tokenTypesLegend.map((t, i) => [t, i]),
);
const tokenModifierIndex = new Map<string, number>(
  tokenModifiersLegend.map((m, i) => [m, i]),
);

const VARIABLE_MODIFIERS: Record<VariableUse['sigil'], string[]> = {
  $: ['global'],
  _: ['local'],
  '@': ['readonly'],
  '%': ['defaultLibrary'],
};

function encodeType(type: string): number {
  return tokenTypeIndex.get(type) ?? 0;
}

function encodeModifiers(modifiers: string[]): number {
  let bits = 0;
  for (const m of modifiers) {
    const idx = tokenModifierIndex.get(m);
    if (idx !== undefined) bits |= (1 << idx);
  }
  return bits;
}

// ---------------------------------------------------------------------------
// Core semantic tokens function (no LSP dependency)
// ---------------------------------------------------------------------------

/** A single absolute-positioned semantic token before delta-encoding. */
export interface AbsoluteToken {
  line: number;
  startChar: number;
  length: number;
  tokenType: number;
  tokenModifiers: number;
}

/**
 * Compute semantic tokens for a document.
 *
 * Tokens emitted, from what Spindle's tooling API reads in each passage:
 *  - Macro names -> 'function' (with 'defaultLibrary' if known macro), also
 *    in the labels and attribute values that hold markup; a macro written in
 *    an HTML comment, which is text, has none
 *  - Story variables ($var) -> 'variable' + 'global'
 *  - Temp variables (_var) -> 'variable' + 'local'
 *  - Local variables (@var) -> 'variable' + 'readonly'
 *  - Transient variables (%var) -> 'variable' + 'defaultLibrary'
 *
 * A variable is a token where code references it, or where StoryVariables /
 * StoryTransients declares it; not in prose, comments or string contents.
 *
 * No keyword tokens: Spindle expressions are plain JavaScript with only the
 * `$ _ @ %` sigils rewritten (expression.ts), so words such as `is`, `to` or
 * `and` are ordinary identifiers at runtime. The legend keeps its `keyword`
 * entry so the type indexes stay stable for clients.
 *  - Passage headers -> 'namespace'
 *
 * Returns absolute tokens (for testing). Use `encodeTokens` to delta-encode.
 */
export function computeSemanticTokensAbsolute(
  uri: string,
  workspace: WorkspaceModel,
): AbsoluteToken[] {
  const doc = workspace.markup.get(uri);
  // JavaScript/TypeScript sources and headerless text hold no story markup
  if (!doc || doc.passages.length === 0) return [];

  const tokens: AbsoluteToken[] = [];
  /** A token over the `content` offsets `[start, end)` of `passage`; a name never spans lines. */
  const push = (passage: PassageMarkup, start: number, end: number, tokenType: string, modifiers: string[]) => {
    const range = passage.range(start, end);
    if (range.start.line !== range.end.line) return;
    tokens.push({
      line: range.start.line,
      startChar: range.start.character,
      length: range.end.character - range.start.character,
      tokenType: encodeType(tokenType),
      tokenModifiers: encodeModifiers(modifiers),
    });
  };

  for (const passage of doc.passages) {
    const headerLine = passage.passage.headerEnd.start.line;

    // Emit passage header tokens
    // :: token (behind the BOM a client's first line may start with)
    tokens.push({
      line: headerLine,
      startChar: headerLine === 0 && doc.text.charCodeAt(0) === 0xfeff ? 1 : 0,
      length: 2,
      tokenType: encodeType('namespace'),
      tokenModifiers: 0,
    });

    // passage name, as the passage parser delimits it (escapes included)
    const { start, end } = passage.passage.nameRange;
    tokens.push({
      line: headerLine,
      startChar: start.character,
      length: end.character - start.character,
      tokenType: encodeType('namespace'),
      tokenModifiers: encodeModifiers(['declaration']),
    });

    for (const macro of macroTokens(passage)) {
      push(passage, macro.nameStart, macro.nameEnd, 'function', workspace.macros.getMacro(macro.name) ? ['defaultLibrary'] : []);
    }
    for (const use of variableUses(passage)) {
      push(passage, use.start, use.end, 'variable', VARIABLE_MODIFIERS[use.sigil]);
    }
  }

  // Sort by line, then by start character
  tokens.sort((a, b) => a.line - b.line || a.startChar - b.startChar);

  // Clients may not support overlapping tokens: keep the first of any overlap
  const result: AbsoluteToken[] = [];
  for (const token of tokens) {
    const prev = result[result.length - 1];
    if (prev && prev.line === token.line && token.startChar < prev.startChar + prev.length) continue;
    result.push(token);
  }
  return result;
}

/**
 * Delta-encode absolute tokens into the LSP wire format.
 *
 * Each token becomes 5 integers: deltaLine, deltaStartChar, length, tokenType, tokenModifiers.
 */
export function encodeTokens(absoluteTokens: AbsoluteToken[]): number[] {
  const data: number[] = [];
  let prevLine = 0;
  let prevChar = 0;

  for (const token of absoluteTokens) {
    const deltaLine = token.line - prevLine;
    const deltaStart = deltaLine === 0 ? token.startChar - prevChar : token.startChar;

    data.push(deltaLine, deltaStart, token.length, token.tokenType, token.tokenModifiers);

    prevLine = token.line;
    prevChar = token.startChar;
  }

  return data;
}

/**
 * Compute delta-encoded semantic tokens for a document.
 */
export function computeSemanticTokens(uri: string, workspace: WorkspaceModel): number[] {
  const absoluteTokens = computeSemanticTokensAbsolute(uri, workspace);
  return encodeTokens(absoluteTokens);
}

// ---------------------------------------------------------------------------
// Plugin wrapper (LSP integration)
// ---------------------------------------------------------------------------

export const semanticTokensPlugin: SpindlePlugin = {
  id: 'semantic-tokens',
  capabilities: {
    semanticTokensProvider: {
      full: true,
      legend: {
        tokenTypes: tokenTypesLegend,
        tokenModifiers: tokenModifiersLegend,
      },
    },
  },
  initialize(ctx: PluginContext) {
    ctx.connection.languages.semanticTokens.on((params) => {
      const data = computeSemanticTokens(params.textDocument.uri, ctx.workspace);
      return { data };
    });
  },
};
