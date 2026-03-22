import type { Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { parseLinks } from '../core/parsing/link-parser.js';

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
 *  - Returns a DocumentLink with the range covering the full link syntax
 *  - Sets `target` to the URI of the file containing the target passage,
 *    with a fragment pointing to the line number
 *
 * Links to unknown passages get `target: undefined`.
 */
export function computeDocumentLinks(uri: string, workspace: WorkspaceModel): DocumentLinkItem[] {
  const text = workspace.documents.getText(uri);
  if (text === undefined) return [];

  const passages = workspace.passages.getPassagesInDocument(uri);
  if (passages.length === 0) return [];

  const links: DocumentLinkItem[] = [];

  // Parse links from each passage's content
  for (const passage of passages) {
    const contentStartLine = passage.range.start.line + 1;
    const contentEndLine = passage.range.end.line + 1;
    const lines = text.split('\n');
    const contentLines = lines.slice(contentStartLine, contentEndLine);
    const content = contentLines.join('\n');

    const passageLinks = parseLinks(content, contentStartLine);

    for (const ref of passageLinks) {
      const targetPassage = workspace.passages.getPassage(ref.name);
      let target: string | undefined;
      if (targetPassage) {
        target = `${targetPassage.uri}#L${targetPassage.range.start.line + 1}`;
      }

      links.push({
        range: ref.range,
        target,
      });
    }
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
