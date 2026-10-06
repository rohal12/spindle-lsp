import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { macroNameRange, parseDocumentMacros } from '../core/parsing/macro-parser.js';
import { executableCodeLines, findTransientReferences, findVariableReferences } from './references.js';

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
 *  - Transient variables (%var) -> 'variable' + 'defaultLibrary'
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
  const text = workspace.documents.getText(uri);
  // JavaScript/TypeScript sources and headerless text hold no story markup
  if (text === undefined || !workspace.hasPassages(uri)) return [];

  const lines = text.split('\n');
  const tokens: AbsoluteToken[] = [];

  // Find header lines for skipping during content scanning
  const headerLines = new Set<number>();
  const passages = workspace.passages.getPassagesInDocument(uri);
  for (const passage of passages) {
    const headerLine = passage.headerEnd.start.line;
    headerLines.add(headerLine);

    // Emit passage header tokens
    // :: token (behind the BOM a client's first line may start with)
    tokens.push({
      line: headerLine,
      startChar: headerLine === 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0,
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
  const macros = parseDocumentMacros(text, passages, undefined, workspace.capabilities);
  for (const macro of macros) {
    const macroLine = macro.range.start.line;
    if (headerLines.has(macroLine)) continue;

    const isDefined = !!workspace.macros.getMacro(macro.name);

    const nameRange = macroNameRange(macro);

    tokens.push({
      line: macroLine,
      startChar: nameRange.start.character,
      length: macro.name.length,
      tokenType: encodeType('function'),
      tokenModifiers: encodeModifiers(isDefined ? ['defaultLibrary'] : []),
    });
  }

  // Variable tokens. A `$` or `%` variable is a token exactly where the
  // variable tracker records a reference or declaration (the one list that
  // navigation, rename and diagnostics share); `_temp` and `@local` have no
  // tracker, so they are tokens in the code Spindle evaluates. Prose, comments,
  // string contents and non-markup passages (script, stylesheet, StoryData) are not code.
  const storyVarRegex = /\$(\w+(?:\.[A-Za-z_$][\w$]*)*)/g;
  const tempVarRegex = /(?<!\w)_([A-Za-z_$][\w$]*)/g;
  const localVarRegex = /(?<!\w)@([A-Za-z_$][\w$]*)/g;
  const transientVarRegex = /(?<!\w)%(\w+(?:\.[A-Za-z_$][\w$]*)*)/g;

  const tracked = new Set<string>();
  const trackName = (sigil: '$' | '%', name: string) => {
    const key = `${sigil}${name}`;
    if (tracked.has(key)) return;
    tracked.add(key);
    const refs = sigil === '$' ? findVariableReferences(name, workspace, true) : findTransientReferences(name, workspace, true);
    for (const r of refs) if (r.uri === uri) tracked.add(`${sigil}@${r.range.start.line}:${r.range.start.character}`);
  };
  const isTracked = (sigil: '$' | '%', name: string, line: number, character: number) => {
    trackName(sigil, name);
    return tracked.has(`${sigil}@${line}:${character}`);
  };

  const codeLines = executableCodeLines(lines, passages, workspace.capabilities);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    if (headerLines.has(lineIndex)) continue;
    const line = lines[lineIndex];

    // Story vars ($var)
    storyVarRegex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = storyVarRegex.exec(line)) !== null) {
      if (!isTracked('$', m[1].split('.')[0], lineIndex, m.index)) continue;
      tokens.push({
        line: lineIndex,
        startChar: m.index,
        length: m[0].length,
        tokenType: encodeType('variable'),
        tokenModifiers: encodeModifiers(['global']),
      });
    }

    // Temp vars (_var)
    const code = codeLines[lineIndex];
    tempVarRegex.lastIndex = 0;
    while ((m = tempVarRegex.exec(code)) !== null) {
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
    while ((m = localVarRegex.exec(code)) !== null) {
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
      if (!isTracked('%', m[1].split('.')[0], lineIndex, m.index)) continue;
      tokens.push({
        line: lineIndex,
        startChar: m.index,
        length: m[0].length,
        tokenType: encodeType('variable'),
        tokenModifiers: encodeModifiers(['defaultLibrary']),
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
