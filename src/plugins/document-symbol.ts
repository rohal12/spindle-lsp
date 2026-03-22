import type { Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { SymbolKind } from 'vscode-languageserver';

// ---------------------------------------------------------------------------
// Core document symbol function (no LSP dependency)
// ---------------------------------------------------------------------------

export interface DocSymbol {
  name: string;
  kind: SymbolKind;
  range: Range;
  selectionRange: Range;
  children?: DocSymbol[];
}

/**
 * Compute document symbols for the outline view and breadcrumbs.
 *
 * Returns:
 *  - Passages as Namespace symbols (full passage range)
 *  - Widget definitions inside [widget] passages as nested Function symbols
 *  - Variable declarations in StoryVariables as nested Variable symbols
 */
export function computeDocumentSymbols(uri: string, workspace: WorkspaceModel): DocSymbol[] {
  const text = workspace.documents.getText(uri);
  if (text === undefined) return [];

  const passages = workspace.passages.getPassagesInDocument(uri);
  if (passages.length === 0) return [];

  const storyVarsPassage = workspace.passages.getStoryVariables();
  const lines = text.split('\n');
  const symbols: DocSymbol[] = [];

  for (const passage of passages) {
    const headerLine = passage.range.start.line;
    const selectionRange: Range = {
      start: { line: headerLine, character: 0 },
      end: { line: headerLine, character: lines[headerLine]?.length ?? 0 },
    };

    const passageSymbol: DocSymbol = {
      name: passage.name,
      kind: SymbolKind.Namespace,
      range: passage.range,
      selectionRange,
      children: [],
    };

    // Widget definitions inside [widget] passages
    if (passage.tags?.includes('widget')) {
      const contentStart = passage.range.start.line + 1;
      const contentEnd = passage.range.end.line + 1;
      const widgetDefRegex = /\{widget\s+"([^"]+)"[^}]*\}/gi;

      for (let i = contentStart; i < contentEnd && i < lines.length; i++) {
        widgetDefRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = widgetDefRegex.exec(lines[i])) !== null) {
          const charStart = match.index;
          const charEnd = charStart + match[0].length;
          passageSymbol.children!.push({
            name: match[1],
            kind: SymbolKind.Function,
            range: {
              start: { line: i, character: charStart },
              end: { line: i, character: charEnd },
            },
            selectionRange: {
              start: { line: i, character: charStart },
              end: { line: i, character: charEnd },
            },
          });
        }
      }
    }

    // Variable declarations in StoryVariables
    if (storyVarsPassage && storyVarsPassage.uri === uri && passage.name === 'StoryVariables') {
      const contentStart = passage.range.start.line + 1;
      const contentEnd = passage.range.end.line + 1;

      for (let i = contentStart; i < contentEnd && i < lines.length; i++) {
        const varMatch = lines[i].match(/^\$([A-Za-z_$][\w$]*)\s*=/);
        if (varMatch) {
          const charEnd = varMatch[0].length;
          passageSymbol.children!.push({
            name: '$' + varMatch[1],
            kind: SymbolKind.Variable,
            range: {
              start: { line: i, character: 0 },
              end: { line: i, character: lines[i].length },
            },
            selectionRange: {
              start: { line: i, character: 0 },
              end: { line: i, character: charEnd },
            },
          });
        }
      }
    }

    symbols.push(passageSymbol);
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Plugin wrapper (LSP integration)
// ---------------------------------------------------------------------------

function toLspRange(r: Range): import('vscode-languageserver').Range {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}

function toLspDocumentSymbol(sym: DocSymbol): import('vscode-languageserver').DocumentSymbol {
  return {
    name: sym.name,
    kind: sym.kind,
    range: toLspRange(sym.range),
    selectionRange: toLspRange(sym.selectionRange),
    children: sym.children?.map(toLspDocumentSymbol),
  };
}

export const documentSymbolPlugin: SpindlePlugin = {
  id: 'document-symbol',
  capabilities: {
    documentSymbolProvider: true,
  },
  initialize(ctx: PluginContext) {
    ctx.connection.onDocumentSymbol((params) => {
      const symbols = computeDocumentSymbols(params.textDocument.uri, ctx.workspace);
      return symbols.map(toLspDocumentSymbol);
    });
  },
};
