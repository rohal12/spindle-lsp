import type { Range } from '../core/types.js';
import { splitLines } from '../core/text.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { parsePassageHeader } from '../core/parsing/passage-parser.js';
import {
  findPassageReferences,
  findVariableReferences,
  findWidgetReferences,
} from './references.js';

// ---------------------------------------------------------------------------
// Core code lens function (no LSP dependency)
// ---------------------------------------------------------------------------

export interface CodeLensItem {
  range: Range;
  command: {
    title: string;
  };
}

/**
 * Compute code lenses for a document.
 *
 * Shows:
 *  - Above passage headers: "N references"
 *  - Above widget definitions: "N usages"
 *  - Above StoryVariables declarations: "N usages"
 */
export function computeCodeLenses(uri: string, workspace: WorkspaceModel): CodeLensItem[] {
  const text = workspace.documents.getText(uri);
  if (text === undefined) return [];

  // Lines end at `\n`; a CRLF document's `\r` is part of the line break, not of the line
  const lines = splitLines(text);
  const lenses: CodeLensItem[] = [];
  const addLens = (line: number, title: string): void => {
    lenses.push({
      range: {
        start: { line, character: 0 },
        end: { line, character: lines[line].length },
      },
      command: { title },
    });
  };

  const variableLines = new Map([...workspace.variables.getDeclared().keys()]
    .flatMap(name => workspace.variables.getDeclarations(name, '$')
      .filter(declaration => declaration.uri === uri)
      .map(declaration => [declaration.range.start.line, name] as const)));
  const widgetLines = new Map(workspace.widgets.getAllWidgets()
    .filter(w => w.uri === uri)
    .map(w => [w.range.start.line, w.name] as const));

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];

    // --- Passage headers ---
    const header = parsePassageHeader(line, lineNum);
    if (header) {
      const passageName = header.name;
      if (passageName === 'StoryData') continue;

      // references only: a name declared twice is two declarations, not references
      const refCount = findPassageReferences(passageName, workspace, false).length;

      addLens(lineNum, `${refCount} reference${refCount !== 1 ? 's' : ''}`);
      continue;
    }

    // --- Widget definitions ---
    const widgetName = widgetLines.get(lineNum);
    if (widgetName !== undefined) {
      const usageCount = findWidgetReferences(widgetName, workspace, false, false).length;

      addLens(lineNum, `${usageCount} usage${usageCount !== 1 ? 's' : ''}`);
    }

    // --- StoryVariables declarations ---
    const varName = variableLines.get(lineNum);
    if (varName !== undefined) {
      const usageCount = findVariableReferences(varName, workspace, false).length;

      addLens(lineNum, `${usageCount} usage${usageCount !== 1 ? 's' : ''}`);
    }
  }

  return lenses;
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

export const codeLensPlugin: SpindlePlugin = {
  id: 'code-lens',
  capabilities: {
    codeLensProvider: {
      resolveProvider: false,
    },
  },
  initialize(ctx: PluginContext) {
    ctx.connection.onCodeLens((params) => {
      const lenses = computeCodeLenses(params.textDocument.uri, ctx.workspace);
      return lenses.map(l => ({
        range: toLspRange(l.range),
        command: {
          title: l.command.title,
          // Informational counts: no editor-specific navigation command is registered.
          command: '',
        },
      }));
    });
  },
};
