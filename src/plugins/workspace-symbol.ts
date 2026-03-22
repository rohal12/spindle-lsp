import type { Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { SymbolKind } from 'vscode-languageserver';

// ---------------------------------------------------------------------------
// Core workspace symbol function (no LSP dependency)
// ---------------------------------------------------------------------------

export interface WorkspaceSymbolItem {
  name: string;
  kind: SymbolKind;
  uri: string;
  range: Range;
}

/**
 * Search for symbols across the entire workspace.
 *
 * Returns:
 *  - All passages as Namespace symbols
 *  - All widgets as Function symbols
 *  - All declared variables as Variable symbols
 *
 * Results are filtered by the query string (case-insensitive substring match).
 */
export function searchWorkspaceSymbols(query: string, workspace: WorkspaceModel): WorkspaceSymbolItem[] {
  const lowerQuery = query.toLowerCase();
  const results: WorkspaceSymbolItem[] = [];

  // Passages
  for (const passage of workspace.passages.getAllPassages()) {
    if (lowerQuery && !passage.name.toLowerCase().includes(lowerQuery)) continue;
    results.push({
      name: passage.name,
      kind: SymbolKind.Namespace,
      uri: passage.uri,
      range: passage.range,
    });
  }

  // Widgets
  for (const widget of workspace.widgets.getAllWidgets()) {
    if (lowerQuery && !widget.name.toLowerCase().includes(lowerQuery)) continue;
    results.push({
      name: widget.name,
      kind: SymbolKind.Function,
      uri: widget.uri,
      range: widget.range,
    });
  }

  // Declared variables
  for (const [name, decl] of workspace.variables.getDeclared()) {
    const displayName = '$' + name;
    if (lowerQuery && !displayName.toLowerCase().includes(lowerQuery)) continue;
    results.push({
      name: displayName,
      kind: SymbolKind.Variable,
      uri: decl.declarationUri ?? '',
      range: decl.declarationRange ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    });
  }

  return results;
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

export const workspaceSymbolPlugin: SpindlePlugin = {
  id: 'workspace-symbol',
  capabilities: {
    workspaceSymbolProvider: true,
  },
  initialize(ctx: PluginContext) {
    ctx.connection.onWorkspaceSymbol((params) => {
      const symbols = searchWorkspaceSymbols(params.query, ctx.workspace);
      return symbols.map(s => ({
        name: s.name,
        kind: s.kind,
        location: {
          uri: s.uri,
          range: toLspRange(s.range),
        },
      }));
    });
  },
};
