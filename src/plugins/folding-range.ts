import type { Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { parseMacros, pairMacros } from '../core/parsing/macro-parser.js';
import { FoldingRangeKind } from 'vscode-languageserver';

// ---------------------------------------------------------------------------
// Core folding range function (no LSP dependency)
// ---------------------------------------------------------------------------

export interface FoldingRangeItem {
  startLine: number;
  endLine: number;
  kind?: string;
}

/**
 * Compute folding ranges for a document.
 *
 * Returns foldable regions for:
 *  - Passages: each passage header to the end of the passage (FoldingRangeKind.Region)
 *  - Block macros: matched {if}...{/if}, {for}...{/for}, etc.
 */
export function computeFoldingRanges(uri: string, workspace: WorkspaceModel): FoldingRangeItem[] {
  const text = workspace.documents.getText(uri);
  if (text === undefined) return [];

  const ranges: FoldingRangeItem[] = [];

  // Passage folding ranges
  const passages = workspace.passages.getPassagesInDocument(uri);
  for (const passage of passages) {
    const startLine = passage.range.start.line;
    const endLine = passage.range.end.line;
    if (endLine > startLine) {
      ranges.push({
        startLine,
        endLine,
        kind: 'region',
      });
    }
  }

  // Block macro folding ranges
  const macros = parseMacros(text);
  pairMacros(macros, (name) => workspace.macros.isBlock(name));

  for (const macro of macros) {
    if (macro.open && macro.pair !== -1) {
      const closingMacro = macros[macro.pair];
      const startLine = macro.range.start.line;
      const endLine = closingMacro.range.start.line;
      if (endLine > startLine) {
        ranges.push({
          startLine,
          endLine,
        });
      }
    }
  }

  return ranges;
}

// ---------------------------------------------------------------------------
// Plugin wrapper (LSP integration)
// ---------------------------------------------------------------------------

export const foldingRangePlugin: SpindlePlugin = {
  id: 'folding-range',
  capabilities: {
    foldingRangeProvider: true,
  },
  initialize(ctx: PluginContext) {
    ctx.connection.onFoldingRanges((params) => {
      const ranges = computeFoldingRanges(params.textDocument.uri, ctx.workspace);
      return ranges.map(r => ({
        startLine: r.startLine,
        endLine: r.endLine,
        kind: r.kind === 'region' ? FoldingRangeKind.Region : undefined,
      }));
    });
  },
};
