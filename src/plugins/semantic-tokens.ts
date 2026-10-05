import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { buildLineStarts, parseMacros } from '../core/parsing/macro-parser.js';
import { isTransientAt } from './references.js';

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

/** Replace the characters of every string/template literal in `code` with spaces. */
function blankStringLiterals(code: string): string {
  let out = '';
  for (let i = 0; i < code.length; i++) {
    const quote = code[i];
    if (quote !== '"' && quote !== "'" && quote !== '`') {
      out += quote;
      continue;
    }
    let end = i + 1;
    while (end < code.length && code[end] !== quote) end += code[end] === '\\' ? 2 : 1;
    // An unterminated literal runs to the end of the arguments
    const stop = Math.min(end, code.length - 1);
    out += code.slice(i, stop + 1).replace(/[^\n]/g, ' ');
    i = stop;
  }
  return out;
}

/**
 * The text with everything but sugar-keyword candidates replaced by spaces
 * (newlines kept): the arguments of macros, minus string literals. Prose,
 * macro names, passage content outside macros and strings are not code.
 */
function keywordCandidateLines(text: string, macros: ReturnType<typeof parseMacros>): string[] {
  const lineStarts = buildLineStarts(text);
  const offset = (p: { line: number; character: number }) => lineStarts[p.line] + p.character;
  const mask: string[] = Array.from(text, ch => (ch === '\n' ? '\n' : ' '));
  for (const macro of macros) {
    if (!macro.open || !macro.rawArgs) continue;
    const end = offset(macro.range.end) - 1; // the closing brace
    const start = end - macro.rawArgs.length;
    const code = blankStringLiterals(text.slice(start, end));
    for (let i = 0; i < code.length; i++) mask[start + i] = code[i] === '\r' ? ' ' : code[i];
  }
  return mask.join('').split('\n');
}

/**
 * Compute semantic tokens for a document.
 *
 * Tokens emitted:
 *  - Macro names -> 'function' (with 'defaultLibrary' if known macro)
 *  - Story variables ($var) -> 'variable' + 'global'
 *  - Temp variables (_var) -> 'variable' + 'local'
 *  - Local variables (@var) -> 'variable' + 'readonly'
 *  - Transient variables (%var) -> 'variable' + 'defaultLibrary'
 *  - Sugar keywords -> 'keyword', only as words of a macro's arguments
 *    outside string/template literals (not inside variable names, property
 *    paths, prose or strings)
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
    // :: token
    tokens.push({
      line: headerLine,
      startChar: 0,
      length: 2,
      tokenType: encodeType('namespace'),
      tokenModifiers: 0,
    });

    // passage name, as the passage parser delimits it (escapes included)
    const { start, end } = passage.nameRange;
    tokens.push({
      line: headerLine,
      startChar: start.character,
      length: end.character - start.character,
      tokenType: encodeType('namespace'),
      tokenModifiers: encodeModifiers(['declaration']),
    });
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
  const storyVarRegex = /(?<!\w)\$([\w$]+(?:\.[A-Za-z_$][\w$]*)*)/g;
  const tempVarRegex = /(?<!\w)_([A-Za-z_$][\w$]*)/g;
  const localVarRegex = /(?<!\w)@([A-Za-z_$][\w$]*)/g;
  const transientVarRegex = /(?<!\w)%([\w$]+(?:\.[A-Za-z_$][\w$]*)*)/g;
  const sugarKeywordRegex = /(?<![\w$@%.])(to|is|isnot|eq|neq|gt|gte|lt|lte|and|or|not|def|ndef)(?![\w$])/g;
  const candidateLines = keywordCandidateLines(text, macros);

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

    // Transient vars (%var)
    transientVarRegex.lastIndex = 0;
    while ((m = transientVarRegex.exec(line)) !== null) {
      if (!isTransientAt(m[1].split('.')[0], uri, lineIndex, m.index, workspace)) continue;
      tokens.push({
        line: lineIndex,
        startChar: m.index,
        length: m[0].length,
        tokenType: encodeType('variable'),
        tokenModifiers: encodeModifiers(['defaultLibrary']),
      });
    }

    // Sugar keywords
    sugarKeywordRegex.lastIndex = 0;
    const candidates = candidateLines[lineIndex] ?? '';
    while ((m = sugarKeywordRegex.exec(candidates)) !== null) {
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
