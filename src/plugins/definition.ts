import type { Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { macroHeadNameAt } from '../core/parsing/macro-parser.js';
import { passageRefAt } from '../core/markup/passage-refs.js';

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
 *  - Passage name written out ([[link]], a quoted goto/include/link/watch/dialog
 *    argument, in labels and attribute values too) -> jump to passage header
 *  - Widget name in {widgetName} -> jump to widget definition
 */
export function getDefinition(
  uri: string,
  position: Position,
  workspace: WorkspaceModel,
): DefinitionResult | null {
  const text = workspace.documents.getText(uri);
  if (text === undefined || !workspace.hasPassages(uri)) return null;

  const lines = text.split('\n');
  if (position.line >= lines.length) return null;
  const line = lines[position.line];

  // --- Passage name written out: [[link]] or a quoted macro argument ---
  const passageResult = getPassageRefDefinition(uri, position, workspace);
  if (passageResult) return passageResult;

  // --- Widget name -> definition ---
  const widgetResult = getWidgetDefinition(uri, text, position, workspace);
  if (widgetResult) return widgetResult;

  return null;
}

// ---------------------------------------------------------------------------
// Sub-functions
// ---------------------------------------------------------------------------

function getPassageRefDefinition(
  uri: string,
  position: Position,
  workspace: WorkspaceModel,
): DefinitionResult | null {
  const doc = workspace.markup.get(uri);
  const ref = doc && passageRefAt(doc, position);
  if (!ref) return null;
  const passage = workspace.passages.getPassage(ref.name);
  if (!passage) return null;
  return {
    uri: passage.uri,
    range: passage.headerEnd,
  };
}

function getWidgetDefinition(
  uri: string,
  text: string,
  position: Position,
  workspace: WorkspaceModel,
): DefinitionResult | null {
  const head = macroHeadNameAt(text, position, workspace.macroHeadPairing(uri));
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
