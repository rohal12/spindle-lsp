import type { Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { parseLinks } from '../core/parsing/link-parser.js';

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
 *  - Passage name in macro args (goto, include, link, button) -> jump to passage
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

  // --- Passage ref in [[link]] ---
  const linkResult = getPassageLinkDefinition(text, position, workspace);
  if (linkResult) return linkResult;

  // --- Passage ref in macro args (goto, include, link, button) ---
  const macroPassageResult = getMacroPassageDefinition(line, position, workspace);
  if (macroPassageResult) return macroPassageResult;

  // --- Widget name -> definition ---
  const widgetResult = getWidgetDefinition(line, position, workspace);
  if (widgetResult) return widgetResult;

  return null;
}

// ---------------------------------------------------------------------------
// Sub-functions
// ---------------------------------------------------------------------------

function getPassageLinkDefinition(
  text: string,
  position: Position,
  workspace: WorkspaceModel,
): DefinitionResult | null {
  const links = parseLinks(text);
  for (const link of links) {
    if (link.range.start.line === position.line &&
      position.character >= link.range.start.character &&
      position.character <= link.range.end.character) {
      const passage = workspace.passages.getPassage(link.name);
      if (passage) {
        return {
          uri: passage.uri,
          range: passage.headerEnd,
        };
      }
    }
  }
  return null;
}

function getMacroPassageDefinition(
  line: string,
  position: Position,
  workspace: WorkspaceModel,
): DefinitionResult | null {
  // Match {goto "passage"}, {include "passage"}, {link "text" "passage"}, {button "text" "passage"}
  const patterns = [
    /\{(?:goto|include)\s+"([^"]+)"\s*\}/gi,
    /\{(?:link|button)\s+"[^"]*"\s+"([^"]+)"\s*\}/gi,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      const passageName = match[1];
      const nameStart = match.index + match[0].indexOf(passageName);
      const nameEnd = nameStart + passageName.length;
      if (position.character >= nameStart && position.character <= nameEnd) {
        const passage = workspace.passages.getPassage(passageName);
        if (passage) {
          return {
            uri: passage.uri,
            range: passage.headerEnd,
          };
        }
      }
    }
  }
  return null;
}

function getWidgetDefinition(
  line: string,
  position: Position,
  workspace: WorkspaceModel,
): DefinitionResult | null {
  // Match {widgetName ...} invocations
  const re = /\{([A-Za-z_$][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    const name = match[1];
    const nameStart = match.index + 1; // skip '{'
    const nameEnd = nameStart + name.length;
    if (position.character >= nameStart && position.character <= nameEnd) {
      // Only if it's not a known macro
      if (workspace.macros.getMacro(name)) continue;

      const widget = workspace.widgets.getWidget(name);
      if (widget) {
        return {
          uri: widget.uri,
          range: widget.range,
        };
      }
    }
  }
  return null;
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
