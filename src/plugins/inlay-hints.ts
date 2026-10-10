import { splitArgs, type Token } from '@rohal12/spindle/tooling';
import type { Range, Position } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import type { PassageMarkup } from '../core/markup/passage-markup.js';

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
 *  - Variable type hints in StoryVariables and StoryTransients
 */
export function computeInlayHints(
  uri: string,
  range: Range,
  workspace: WorkspaceModel,
): InlayHintItem[] {
  const markup = workspace.markup.get(uri);
  if (markup === undefined) return [];

  const hints: InlayHintItem[] = [];
  const inRange = (line: number) => line >= range.start.line && line <= range.end.line;

  addWidgetParamHints(markup.passages, inRange, workspace, hints);
  addTypeHints(workspace.passages.getStoryVariables(), markup.passages, inRange, hints);
  addTypeHints(workspace.passages.getStoryTransients(), markup.passages, inRange, hints);

  return hints;
}

// ---------------------------------------------------------------------------
// Widget parameter hints
// ---------------------------------------------------------------------------

function addWidgetParamHints(
  passages: readonly PassageMarkup[],
  inRange: (line: number) => boolean,
  workspace: WorkspaceModel,
  hints: InlayHintItem[],
): void {
  if (workspace.widgets.getAllWidgets().length === 0) return;

  for (const passage of passages) {
    // Invocations in the labels and attribute values that hold markup count too
    const tokens: Token[] = [...passage.tokens];
    for (const piece of passage.pieces) {
      if (piece.kind === 'text') tokens.push(...piece.tokens);
    }

    for (const token of tokens) {
      if (token.type !== 'macro' || token.isClose || token.rawArgs === '') continue;
      if (!inRange(passage.position(token.start).line)) continue;

      const widget = workspace.widgets.getWidget(token.name);
      if (!widget || widget.params.length === 0) continue;

      // Spindle's own split of the arguments: each is a trimmed piece of rawArgs, in order
      const args = splitArgs(token.rawArgs);
      let from = 0;
      for (let i = 0; i < Math.min(args.length, widget.params.length); i++) {
        const at = token.rawArgs.indexOf(args[i], from);
        if (at === -1) break;
        from = at + args[i].length;
        hints.push({
          position: passage.position(token.argsStart + at),
          label: `${widget.params[i]}:`,
          kind: 'parameter',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Variable type hints in StoryVariables / StoryTransients
// ---------------------------------------------------------------------------

/** The type of each declaration of `special` (the passage that declares variables) whose default is static. */
function addTypeHints(
  special: { name: string } | undefined,
  passages: readonly PassageMarkup[],
  inRange: (line: number) => boolean,
  hints: InlayHintItem[],
): void {
  const passage = passages.find(p => p.passage === special);
  if (!passage) return;

  for (const declaration of passage.declarations.declarations) {
    if (!declaration.schema) continue;
    const position = passage.position(passage.content.indexOf('=', declaration.nameEnd));
    if (!inRange(position.line)) continue;
    hints.push({ position, label: `: ${declaration.schema.type}`, kind: 'type' });
  }
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
