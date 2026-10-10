import type { Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { documentPassageRefs } from '../core/markup/passage-refs.js';

// ---------------------------------------------------------------------------
// Core document link function (no LSP dependency)
// ---------------------------------------------------------------------------

export interface DocumentLinkItem {
  range: Range;
  target: string | undefined;
}

/**
 * Compute document links for [[passage]] references.
 *
 * For each [[Target]] or [[Display|Target]] link:
 *  - Returns a DocumentLink with the range covering the link's target
 *  - Sets `target` to the URI of the file containing the target passage,
 *    with a fragment pointing to the line number
 *
 * Links to unknown passages get `target: undefined`.
 */
export function computeDocumentLinks(uri: string, workspace: WorkspaceModel): DocumentLinkItem[] {
  const doc = workspace.markup.get(uri);
  if (!doc) return [];

  const links: DocumentLinkItem[] = [];
  // Passages Spindle does not tokenize as markup (script, stylesheet,
  // StoryData, ...) hold code or data, not links: they have no references
  for (const ref of documentPassageRefs(doc)) {
    if (ref.form !== 'bracket') continue;
    const targetPassage = workspace.passages.getPassage(ref.name);
    links.push({
      range: ref.range,
      target: targetPassage ? `${targetPassage.uri}#L${targetPassage.range.start.line + 1}` : undefined,
    });
  }
  return links;
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

export const documentLinkPlugin: SpindlePlugin = {
  id: 'document-link',
  capabilities: {
    documentLinkProvider: {
      resolveProvider: false,
    },
  },
  initialize(ctx: PluginContext) {
    ctx.connection.onDocumentLinks((params) => {
      const links = computeDocumentLinks(params.textDocument.uri, ctx.workspace);
      return links.map(l => ({
        range: toLspRange(l.range),
        target: l.target,
      }));
    });
  },
};
