import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { walkNodes } from '../core/markup/tree.js';
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
  if (workspace.documents.getText(uri) === undefined) return [];

  const ranges: FoldingRangeItem[] = [];

  // Passage folding ranges
  for (const passage of workspace.passages.getPassagesInDocument(uri)) {
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

  // Block macro folding ranges: a macro with a closer, from its opener to its closer
  for (const passage of workspace.markup.get(uri)?.passages ?? []) {
    for (const node of walkNodes(passage.pairing.nodes)) {
      if (node.token.type !== 'macro' || !node.body?.close) continue;
      const startLine = passage.position(node.token.start).line;
      const endLine = passage.position(node.body.close.start).line;
      if (endLine > startLine) ranges.push({ startLine, endLine });
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
