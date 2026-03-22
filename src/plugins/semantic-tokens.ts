import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { parseMacros } from '../core/parsing/macro-parser.js';

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
 * Tokens emitted:
 *  - Macro names -> 'function' (with 'defaultLibrary' if known macro)
 *  - Story variables ($var) -> 'variable' + 'global'
 *  - Temp variables (_var) -> 'variable' + 'local'
 *  - Local variables (@var) -> 'variable' + 'readonly'
 *  - Sugar keywords -> 'keyword'
 *  - Passage headers -> 'namespace'
 *
 * Returns absolute tokens (for testing). Use `encodeTokens` to delta-encode.
 */
export function computeSemanticTokensAbsolute(
  uri: string,
  workspace: WorkspaceModel,
): AbsoluteToken[] {
  const text = workspace.documents.getText(uri);
  if (text === undefined) return [];

  const lines = text.split('\n');
  const tokens: AbsoluteToken[] = [];

  // Find header lines for skipping during content scanning
  const headerLines = new Set<number>();
  const passages = workspace.passages.getPassagesInDocument(uri);
  for (const passage of passages) {
    const headerLine = passage.headerEnd.start.line;
    headerLines.add(headerLine);

    // Emit passage header tokens
    const rawLine = lines[headerLine] ?? '';
    // :: token
    tokens.push({
      line: headerLine,
      startChar: 0,
      length: 2,
      tokenType: encodeType('namespace'),
      tokenModifiers: 0,
    });

    // passage name
    const nameMatch = rawLine.match(/^::\s*(\S.*?)(?:\s*\[|\s*\{|\s*$)/);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      const nameStart = rawLine.indexOf(name);
      tokens.push({
        line: headerLine,
        startChar: nameStart,
        length: name.length,
        tokenType: encodeType('namespace'),
        tokenModifiers: encodeModifiers(['declaration']),
      });
    }
  }

  // Macro name tokens
  const macros = parseMacros(text);
  for (const macro of macros) {
    const macroLine = macro.range.start.line;
    const macroChar = macro.range.start.character;
    if (headerLines.has(macroLine)) continue;

    const isDefined = !!workspace.macros.getMacro(macro.name);

    let nameOffset = 1; // for '{'
    if (!macro.open) nameOffset += 1; // for '/'
    if (macro.cssPrefix) nameOffset += macro.cssPrefix.length + 1;

    tokens.push({
      line: macroLine,
      startChar: macroChar + nameOffset,
      length: macro.name.length,
      tokenType: encodeType('function'),
      tokenModifiers: encodeModifiers(isDefined ? ['defaultLibrary'] : []),
    });
  }

  // Variable and keyword tokens
  const storyVarRegex = /(?<!\w)\$([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
  const tempVarRegex = /(?<!\w)_([A-Za-z_$][\w$]*)/g;
  const localVarRegex = /(?<!\w)@([A-Za-z_$][\w$]*)/g;
  const sugarKeywordRegex = /\b(to|is|isnot|eq|neq|gt|gte|lt|lte|and|or|not|def|ndef)\b/g;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    if (headerLines.has(lineIndex)) continue;
    const line = lines[lineIndex];

    // Story vars ($var)
    storyVarRegex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = storyVarRegex.exec(line)) !== null) {
      tokens.push({
        line: lineIndex,
        startChar: m.index,
        length: m[0].length,
        tokenType: encodeType('variable'),
        tokenModifiers: encodeModifiers(['global']),
      });
    }

    // Temp vars (_var)
    tempVarRegex.lastIndex = 0;
    while ((m = tempVarRegex.exec(line)) !== null) {
      tokens.push({
        line: lineIndex,
        startChar: m.index,
        length: m[0].length,
        tokenType: encodeType('variable'),
        tokenModifiers: encodeModifiers(['local']),
      });
    }

    // Local vars (@var)
    localVarRegex.lastIndex = 0;
    while ((m = localVarRegex.exec(line)) !== null) {
      tokens.push({
        line: lineIndex,
        startChar: m.index,
        length: m[0].length,
        tokenType: encodeType('variable'),
        tokenModifiers: encodeModifiers(['readonly']),
      });
    }

    // Sugar keywords
    sugarKeywordRegex.lastIndex = 0;
    while ((m = sugarKeywordRegex.exec(line)) !== null) {
      tokens.push({
        line: lineIndex,
        startChar: m.index,
        length: m[0].length,
        tokenType: encodeType('keyword'),
        tokenModifiers: 0,
      });
    }
  }

  // Sort by line, then by start character
  tokens.sort((a, b) => a.line - b.line || a.startChar - b.startChar);

  return tokens;
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
