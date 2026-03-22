import type { Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
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

  const lines = text.split('\n');
  const lenses: CodeLensItem[] = [];

  const storyVarsPassage = workspace.passages.getStoryVariables();
  const isStoryVarsFile = storyVarsPassage && storyVarsPassage.uri === uri;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];

    // --- Passage headers ---
    const passageMatch = line.match(/^::\s*(\S.*?)(?:\s*\[|\s*\{|\s*$)/);
    if (passageMatch) {
      const passageName = passageMatch[1].trim();
      if (passageName === 'StoryData') continue;

      const refs = findPassageReferences(passageName, workspace, true);
      const refCount = Math.max(0, refs.length - 1);

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
    const widgetMatch = line.match(/\{widget\s+"([^"]+)"/);
    if (widgetMatch) {
      const widgetName = widgetMatch[1];
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
    if (isStoryVarsFile) {
      const varDeclMatch = line.match(/^\$([A-Za-z_$][\w$]*)\s*=/);
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
