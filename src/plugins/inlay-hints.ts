import type { Range, Position } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { parseMacros } from '../core/parsing/macro-parser.js';
import { lexArguments } from '../core/parsing/argument-lexer.js';

// ---------------------------------------------------------------------------
// Core inlay hints function (no LSP dependency)
// ---------------------------------------------------------------------------

export interface InlayHintItem {
  position: Position;
  label: string;
  kind: 'type' | 'parameter';
}

/**
 * Compute inlay hints for a document within a range.
 *
 * Provides:
 *  - Widget invocation args -> parameter name hints
 *  - Variable type hints in StoryVariables
 */
export function computeInlayHints(
  uri: string,
  range: Range,
  workspace: WorkspaceModel,
): InlayHintItem[] {
  const text = workspace.documents.getText(uri);
  if (text === undefined) return [];

  const hints: InlayHintItem[] = [];

  addWidgetParamHints(text, range, workspace, hints);
  addVariableTypeHints(uri, text, range, workspace, hints);
  addTransientTypeHints(uri, text, range, workspace, hints);

  return hints;
}

// ---------------------------------------------------------------------------
// Widget parameter hints
// ---------------------------------------------------------------------------

function addWidgetParamHints(
  text: string,
  range: Range,
  workspace: WorkspaceModel,
  hints: InlayHintItem[],
): void {
  const allWidgets = workspace.widgets.getAllWidgets();
  if (allWidgets.length === 0) return;

  const widgetMap = new Map(allWidgets.map(w => [w.name, w]));
  const macros = parseMacros(text);

  for (const macro of macros) {
    if (!macro.open) continue;
    // Check if macro is within the requested range
    if (macro.range.start.line < range.start.line || macro.range.start.line > range.end.line) continue;

    const widget = widgetMap.get(macro.name);
    if (!widget || widget.params.length === 0) continue;

    if (!macro.rawArgs || macro.rawArgs.trim() === '') continue;

    const args = lexArguments(macro.rawArgs);

    // Find the position of each arg in the original text line
    const lines = text.split('\n');
    const macroLine = lines[macro.range.start.line];
    if (!macroLine) continue;

    const macroText = macroLine.substring(macro.range.start.character, macro.range.end.character);
    const nameEnd = macroText.indexOf(macro.name) + macro.name.length;
    const argsText = macroText.substring(nameEnd).replace(/^\s+/, '').replace(/\}$/, '');
    if (!argsText) continue;

    for (let i = 0; i < Math.min(args.length, widget.params.length); i++) {
      const argText = args[i].text;
      const idx = macroLine.indexOf(argText, macro.range.start.character + nameEnd);
      if (idx >= 0) {
        hints.push({
          position: { line: macro.range.start.line, character: idx },
          label: `@${widget.params[i]}:`,
          kind: 'parameter',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Variable type hints in StoryVariables
// ---------------------------------------------------------------------------

function addVariableTypeHints(
  uri: string,
  text: string,
  range: Range,
  workspace: WorkspaceModel,
  hints: InlayHintItem[],
): void {
  const storyVarsPassage = workspace.passages.getStoryVariables();
  if (!storyVarsPassage) return;
  if (storyVarsPassage.uri !== uri) return;

  const lines = text.split('\n');
  const startLine = Math.max(range.start.line, 0);
  const endLine = Math.min(range.end.line, lines.length - 1);

  for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
    const line = lines[lineNum];
    const declMatch = line.match(/^\$([A-Za-z_$][\w$]*)\s*=\s*(.+)$/);
    if (!declMatch) continue;

    const valueStr = declMatch[2].trim();
    const inferredType = inferType(valueStr);
    if (!inferredType) continue;

    const eqIdx = line.indexOf('=');
    hints.push({
      position: { line: lineNum, character: eqIdx },
      label: `: ${inferredType}`,
      kind: 'type',
    });
  }
}

// ---------------------------------------------------------------------------
// Transient variable type hints in StoryTransients
// ---------------------------------------------------------------------------

function addTransientTypeHints(
  uri: string,
  text: string,
  range: Range,
  workspace: WorkspaceModel,
  hints: InlayHintItem[],
): void {
  const storyTransientsPassage = workspace.passages.getStoryTransients();
  if (!storyTransientsPassage) return;
  if (storyTransientsPassage.uri !== uri) return;

  const lines = text.split('\n');
  const startLine = Math.max(range.start.line, 0);
  const endLine = Math.min(range.end.line, lines.length - 1);

  for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
    const line = lines[lineNum];
    const declMatch = line.match(/^%([A-Za-z_$][\w$]*)\s*=\s*(.+)$/);
    if (!declMatch) continue;

    const valueStr = declMatch[2].trim();
    const inferredType = inferType(valueStr);
    if (!inferredType) continue;

    const eqIdx = line.indexOf('=');
    hints.push({
      position: { line: lineNum, character: eqIdx },
      label: `: ${inferredType}`,
      kind: 'type',
    });
  }
}

function inferType(value: string): string | null {
  if (/^\d+(\.\d+)?$/.test(value)) return 'number';
  if (/^"[^"]*"$/.test(value) || /^'[^']*'$/.test(value)) return 'string';
  if (/^\[/.test(value)) return 'array';
  if (/^\{/.test(value)) return 'object';
  if (value === 'true' || value === 'false') return 'boolean';
  if (value === 'null') return 'null';
  if (value === 'undefined') return 'undefined';
  return null;
}

// ---------------------------------------------------------------------------
// Plugin wrapper (LSP integration)
// ---------------------------------------------------------------------------

export const inlayHintsPlugin: SpindlePlugin = {
  id: 'inlay-hints',
  capabilities: {
    inlayHintProvider: true,
  },
  initialize(ctx: PluginContext) {
    ctx.connection.languages.inlayHint.on((params) => {
      const range: Range = {
        start: { line: params.range.start.line, character: params.range.start.character },
        end: { line: params.range.end.line, character: params.range.end.character },
      };

      const hints = computeInlayHints(params.textDocument.uri, range, ctx.workspace);

      return hints.map(h => ({
        position: { line: h.position.line, character: h.position.character },
        label: h.label,
        kind: h.kind === 'type' ? 1 : 2,
        paddingRight: h.kind === 'parameter',
        paddingLeft: h.kind === 'type',
      }));
    });
  },
};
