import type { Hover, Range as LspRange } from 'vscode-languageserver';
import type { Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import type { PassageMarkup } from '../core/markup/passage-markup.js';
import { positionToOffset } from '../core/text.js';
import { macroTokens, variableUses, type VariableUse } from './markup-symbols.js';

// ---------------------------------------------------------------------------
// Core hover function (no LSP dependency)
// ---------------------------------------------------------------------------

export interface HoverResult {
  contents: string;
  range: Range;
}

/**
 * Compute hover information for the symbol at the given position.
 *
 * Provides information for:
 *  - Macro names -> description, parameters, block/inline
 *  - Variables -> "Story variable" / "Temp variable" / "Local variable" + type info
 *  - Widget names -> widget info with params
 *
 * The symbols are those Spindle's tooling API reads in the passage's markup
 * (see markup-symbols.ts), the same ones the semantic tokens highlight:
 * macros and variables in a label or an HTML attribute value count, text in
 * a comment, a string or prose does not.
 */
export function getHoverInfo(
  uri: string,
  position: Position,
  workspace: WorkspaceModel,
): HoverResult | null {
  const doc = workspace.markup.get(uri);
  if (!doc) return null;
  const passage = doc.passageAt(position);
  if (!passage) return null;
  const offset = positionToOffset(position, doc.lineStarts);
  if (offset < passage.bodyStart) return null;
  const at = passage.contentOffset(offset);

  return getMacroHover(passage, at, workspace) ?? getVariableHover(passage, at, workspace);
}

// ---------------------------------------------------------------------------
// Sub-functions
// ---------------------------------------------------------------------------

function getMacroHover(passage: PassageMarkup, at: number, workspace: WorkspaceModel): HoverResult | null {
  for (const macro of macroTokens(passage)) {
    if (at < macro.nameStart || at > macro.nameEnd) continue;
    const range = passage.range(macro.nameStart, macro.nameEnd);

    const info = workspace.macros.getMacro(macro.name);
    if (info) {
      const parts: string[] = [];
      parts.push(`**${info.name}** _(${info.block ? 'container' : 'inline'} macro)_`);
      if (info.description) {
        parts.push('', info.description);
      }
      if (info.parameters && info.parameters.length > 0) {
        parts.push('', `Parameters: \`${info.parameters.join(' ')}\``);
      }
      return { contents: parts.join('\n'), range };
    }

    const widget = workspace.widgets.getWidget(macro.name);
    if (widget) return buildWidgetHover(widget, range);
  }
  return null;
}

const VARIABLE_KINDS: Record<VariableUse['sigil'], string> = {
  $: 'Story variable',
  _: 'Temp variable',
  '@': 'Local variable',
  '%': 'Transient variable',
};

function getVariableHover(passage: PassageMarkup, at: number, workspace: WorkspaceModel): HoverResult | null {
  // A cursor between two adjacent variables (`$a$b`) belongs to the first, as for any token that ends there
  const use = variableUses(passage).find(candidate => candidate.start <= at && at <= candidate.end);
  if (!use) return null;

  const declared = use.sigil === '$' ? workspace.variables.getDeclared()
    : use.sigil === '%' ? workspace.variables.getDeclaredTransient()
    : undefined;
  const fields = declared?.get(use.name)?.fields;
  const typeInfo = fields && fields.length > 0 ? `\n\nFields: ${fields.map(f => `\`${f}\``).join(', ')}` : '';
  return {
    contents: `**${VARIABLE_KINDS[use.sigil]}** \`${passage.content.slice(use.start, use.end)}\`${typeInfo}`,
    range: passage.range(use.start, use.end),
  };
}

function buildWidgetHover(widget: import('../core/types.js').WidgetDef, range: Range): HoverResult {
  const sig = widget.params.length > 0
    ? widget.params.join(', ')
    : 'no parameters';
  return {
    contents: `**Widget** \`${widget.name}\`\n\nParameters: ${sig}\n\nDefined in: \`${widget.uri}\``,
    range,
  };
}

// ---------------------------------------------------------------------------
// Plugin wrapper (LSP integration)
// ---------------------------------------------------------------------------

function toLspRange(r: Range): LspRange {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}

export const hoverPlugin: SpindlePlugin = {
  id: 'hover',
  capabilities: {
    hoverProvider: true,
  },
  initialize(ctx: PluginContext) {
    ctx.connection.onHover((params): Hover | null => {
      const result = getHoverInfo(
        params.textDocument.uri,
        { line: params.position.line, character: params.position.character },
        ctx.workspace,
      );
      if (!result) return null;
      return {
        contents: { kind: 'markdown', value: result.contents },
        range: toLspRange(result.range),
      };
    });
  },
};
