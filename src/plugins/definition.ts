import type { Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { macroHeadNameAt } from '../core/parsing/macro-parser.js';
import { findPassageRefAt } from '../core/parsing/link-parser.js';

// ---------------------------------------------------------------------------
// Core definition function (no LSP dependency)
// ---------------------------------------------------------------------------

export interface DefinitionResult {
  uri: string;
  range: Range;
}

/**
 * Compute go-to-definition for the symbol at the given position.
 *
 * Supports:
 *  - Passage name in [[link]] -> jump to passage header
 *  - Passage name in macro args (goto, include, link) -> jump to passage
 *  - Widget name in {widgetName} -> jump to widget definition
 */
export function getDefinition(
  uri: string,
  position: Position,
  workspace: WorkspaceModel,
): DefinitionResult | null {
  const text = workspace.documents.getText(uri);
  if (text === undefined) return null;

  const lines = text.split('\n');
  if (position.line >= lines.length) return null;
  const line = lines[position.line];

  // --- Passage ref in [[link]] or macro args (goto, include, link) ---
  const passageResult = getPassageRefDefinition(text, position, workspace);
  if (passageResult) return passageResult;

  // --- Widget name -> definition ---
  const widgetResult = getWidgetDefinition(text, position, workspace);
  if (widgetResult) return widgetResult;

  return null;
}

// ---------------------------------------------------------------------------
// Sub-functions
// ---------------------------------------------------------------------------

function getPassageRefDefinition(
  text: string,
  position: Position,
  workspace: WorkspaceModel,
): DefinitionResult | null {
  const ref = findPassageRefAt(text, position);
  if (!ref) return null;
  const passage = workspace.passages.getPassage(ref.name);
  if (!passage) return null;
  return {
    uri: passage.uri,
    range: passage.headerEnd,
  };
}

function getWidgetDefinition(
  text: string,
  position: Position,
  workspace: WorkspaceModel,
): DefinitionResult | null {
  const head = macroHeadNameAt(text, position);
  if (!head) return null;
  // Only if it's not a known macro
  if (workspace.macros.getMacro(head.name)) return null;
  const widget = workspace.widgets.getWidget(head.name);
  return widget ? { uri: widget.uri, range: widget.range } : null;
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

export const definitionPlugin: SpindlePlugin = {
  id: 'definition',
  capabilities: {
    definitionProvider: true,
  },
  initialize(ctx: PluginContext) {
    ctx.connection.onDefinition((params) => {
      const result = getDefinition(
        params.textDocument.uri,
        { line: params.position.line, character: params.position.character },
        ctx.workspace,
      );
      if (!result) return null;
      return {
        uri: result.uri,
        range: toLspRange(result.range),
      };
    });
  },
};
