import type { Range } from '../core/types.js';
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
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  const lenses: CodeLensItem[] = [];

  const storyVarsPassage = workspace.passages.getStoryVariables();
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

      lenses.push({
        range: {
          start: { line: lineNum, character: 0 },
          end: { line: lineNum, character: line.length },
        },
        command: {
          title: `${refCount} reference${refCount !== 1 ? 's' : ''}`,
        },
      });
      continue;
    }

    // --- Widget definitions ---
    const widgetName = widgetLines.get(lineNum);
    if (widgetName !== undefined) {
      const refs = findWidgetReferences(widgetName, workspace, true);
      const usageCount = Math.max(0, refs.length - 1);

      lenses.push({
        range: {
          start: { line: lineNum, character: 0 },
          end: { line: lineNum, character: line.length },
        },
        command: {
          title: `${usageCount} usage${usageCount !== 1 ? 's' : ''}`,
        },
      });
    }

    // --- StoryVariables declarations ---
    if (storyVarsPassage && storyVarsPassage.uri === uri &&
      lineNum > storyVarsPassage.range.start.line && lineNum <= storyVarsPassage.range.end.line) {
      const varDeclMatch = line.match(/^\$(\w+)\s*=/);
      if (varDeclMatch) {
        const varName = varDeclMatch[1];
        const refs = findVariableReferences(varName, workspace, true);
        const usageCount = Math.max(0, refs.length - 1);

        lenses.push({
          range: {
            start: { line: lineNum, character: 0 },
            end: { line: lineNum, character: line.length },
          },
          command: {
            title: `${usageCount} usage${usageCount !== 1 ? 's' : ''}`,
          },
        });
      }
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
          command: 'spindle.findReferences',
        },
      }));
    });
  },
};
