import type { Hover, Range as LspRange } from 'vscode-languageserver';
import type { Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';

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
 */
export function getHoverInfo(
  uri: string,
  position: Position,
  workspace: WorkspaceModel,
): HoverResult | null {
  const text = workspace.documents.getText(uri);
  if (text === undefined) return null;

  const lines = text.split('\n');
  if (position.line >= lines.length) return null;
  const line = lines[position.line];

  // --- Macro name hover ---
  // Check if cursor is on a macro name inside {macroName ...} or {/macroName}
  const macroResult = getMacroHover(line, position, workspace);
  if (macroResult) return macroResult;

  // --- Variable hover ---
  const varResult = getVariableHover(line, position, workspace);
  if (varResult) return varResult;

  // --- Widget invocation hover ---
  const widgetResult = getWidgetHover(line, position, workspace);
  if (widgetResult) return widgetResult;

  return null;
}

// ---------------------------------------------------------------------------
// Sub-functions
// ---------------------------------------------------------------------------

function getMacroHover(
  line: string,
  position: Position,
  workspace: WorkspaceModel,
): HoverResult | null {
  // Match macro patterns: {macroName ...} or {/macroName}
  const macroRegex = /\{(\/)?(?:(?:[#.][a-zA-Z][\w-]*\s*)*)([A-Za-z][\w-]*)/g;
  let match: RegExpExecArray | null;

  while ((match = macroRegex.exec(line)) !== null) {
    const name = match[2];
    const nameStart = match.index + match[0].indexOf(name);
    const nameEnd = nameStart + name.length;

    if (position.character >= nameStart && position.character <= nameEnd) {
      const info = workspace.macros.getMacro(name);
      if (info) {
        const parts: string[] = [];
        parts.push(`**${info.name}** _(${info.block ? 'container' : 'inline'} macro)_`);
        if (info.description) {
          parts.push('', info.description);
        }
        if (info.parameters && info.parameters.length > 0) {
          parts.push('', `Parameters: \`${info.parameters.join(' ')}\``);
        }

        return {
          contents: parts.join('\n'),
          range: {
            start: { line: position.line, character: nameStart },
            end: { line: position.line, character: nameEnd },
          },
        };
      }

      // Check widgets
      const widget = workspace.widgets.getWidget(name);
      if (widget) {
        return buildWidgetHover(widget, position.line, nameStart, nameEnd);
      }
    }
  }

  return null;
}

function getVariableHover(
  line: string,
  position: Position,
  workspace: WorkspaceModel,
): HoverResult | null {
  // Story variables: $name
  {
    const re = /\$([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        const baseName = match[1].split('.')[0];
        const decl = workspace.variables.getDeclared().get(baseName);
        const typeInfo = decl?.fields && decl.fields.length > 0
          ? `\n\nFields: ${decl.fields.map(f => `\`${f}\``).join(', ')}`
          : '';
        return {
          contents: `**Story variable** \`$${match[1]}\`${typeInfo}`,
          range: {
            start: { line: position.line, character: start },
            end: { line: position.line, character: end },
          },
        };
      }
    }
  }

  // Temp variables: _name
  {
    const re = /(?<!\w)_([A-Za-z_$][\w$]*)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        return {
          contents: `**Temp variable** \`_${match[1]}\``,
          range: {
            start: { line: position.line, character: start },
            end: { line: position.line, character: end },
          },
        };
      }
    }
  }

  // Local variables: @name
  {
    const re = /(?<!\w)@([A-Za-z_$][\w$]*)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        return {
          contents: `**Local variable** \`@${match[1]}\``,
          range: {
            start: { line: position.line, character: start },
            end: { line: position.line, character: end },
          },
        };
      }
    }
  }

  return null;
}

function getWidgetHover(
  line: string,
  position: Position,
  workspace: WorkspaceModel,
): HoverResult | null {
  // Widget invocation: {widgetName ...}
  const re = /\{([A-Za-z_$][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    const name = match[1];
    const nameStart = match.index + 1; // skip '{'
    const nameEnd = nameStart + name.length;
    if (position.character >= nameStart && position.character <= nameEnd) {
      const widget = workspace.widgets.getWidget(name);
      if (widget) {
        return buildWidgetHover(widget, position.line, nameStart, nameEnd);
      }
    }
  }
  return null;
}

function buildWidgetHover(
  widget: import('../core/types.js').WidgetDef,
  line: number,
  nameStart: number,
  nameEnd: number,
): HoverResult {
  const sig = widget.params.length > 0
    ? widget.params.map(p => `@${p}`).join(', ')
    : 'no parameters';
  return {
    contents: `**Widget** \`${widget.name}\`\n\nParameters: ${sig}\n\nDefined in: \`${widget.uri}\``,
    range: {
      start: { line, character: nameStart },
      end: { line, character: nameEnd },
    },
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
