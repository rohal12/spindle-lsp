import type { Hover, Range as LspRange } from 'vscode-languageserver';
import type { Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { buildLineStarts, macroNameRange, parseDocumentMacros } from '../core/parsing/macro-parser.js';
import { executableCodeLines, variableAt } from './references.js';
import { isMarkupPassage } from '../core/parsing/passage-parser.js';
import { inAttributeValue } from '../core/parsing/html-scanner.js';

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
 * Macros and widgets written inside an HTML attribute value get no hover:
 * Spindle outputs them there as text (SP103).
 */
export function getHoverInfo(
  uri: string,
  position: Position,
  workspace: WorkspaceModel,
): HoverResult | null {
  const text = workspace.documents.getText(uri);
  if (text === undefined || !workspace.hasPassages(uri)) return null;

  const lines = text.split('\n');
  if (position.line >= lines.length) return null;
  const line = lines[position.line];
  // Only variables mean something outside story markup (the declarations of
  // StoryVariables/StoryTransients); macros and widgets are not called in
  // script, stylesheet or data passages
  const markup = isMarkupPassage(workspace.passages.getPassageAt(uri, position.line) ?? {});

  // Spindle outputs macros and widgets inside an attribute value as text
  const offset = (buildLineStarts(text)[position.line] ?? 0) + position.character;
  const inAttribute = inAttributeValue(text, offset);

  // --- Macro name hover ---
  // Check if cursor is on a macro name inside {macroName ...} or {/macroName}
  const macroResult = inAttribute || !markup ? null : getMacroHover(uri, text, position, workspace);
  if (macroResult) return macroResult;

  // --- Variable hover ---
  const code = executableCodeLines(lines, workspace.passages.getPassagesInDocument(uri))[position.line] ?? '';
  const varResult = getVariableHover(uri, line, code, position, workspace);
  if (varResult) return varResult;

  return null;
}

// ---------------------------------------------------------------------------
// Sub-functions
// ---------------------------------------------------------------------------

function getMacroHover(
  uri: string,
  text: string,
  position: Position,
  workspace: WorkspaceModel,
): HoverResult | null {
  // The macros Spindle's tokenizer reads (the one grammar every consumer shares):
  // `{wid.cls}` is a macro named `wid.cls`, and an unterminated `{goto "x` is text
  const macros = parseDocumentMacros(text, workspace.passages.getPassagesInDocument(uri), undefined, workspace.capabilities);
  for (const macro of macros) {
    const { start, end } = macroNameRange(macro);
    if (position.line !== start.line || position.character < start.character || position.character > end.character) continue;

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
      return { contents: parts.join('\n'), range: { start, end } };
    }

    const widget = workspace.widgets.getWidget(macro.name);
    if (widget) return buildWidgetHover(widget, start.line, start.character, end.character);
  }
  return null;
}

function getVariableHover(
  uri: string,
  line: string,
  code: string,
  position: Position,
  workspace: WorkspaceModel,
): HoverResult | null {
  // `$` and `%` variables are the ones the variable tracker records (the same
  // list references, rename and highlighting use); `_` and `@` are the ones in code
  const tracked = variableAt(uri, position, workspace);
  // Story variables: $name
  if (tracked?.sigil === '$') {
    const decl = workspace.variables.getDeclared().get(tracked.name);
    const typeInfo = decl?.fields && decl.fields.length > 0
      ? `\n\nFields: ${decl.fields.map(f => `\`${f}\``).join(', ')}`
      : '';
    return {
      contents: `**Story variable** \`${line.slice(tracked.range.start.character, tracked.range.end.character)}\`${typeInfo}`,
      range: tracked.range,
    };
  }

  // Temp variables: _name
  {
    const re = /(?<!\w)_([A-Za-z_$][\w$]*)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(code)) !== null) {
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
    while ((match = re.exec(code)) !== null) {
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

  // Transient variables: %name
  if (tracked?.sigil === '%') {
    const decl = workspace.variables.getDeclaredTransient().get(tracked.name);
    const typeInfo = decl?.fields && decl.fields.length > 0
      ? `\n\nFields: ${decl.fields.map(f => `\`${f}\``).join(', ')}`
      : '';
    return {
      contents: `**Transient variable** \`${line.slice(tracked.range.start.character, tracked.range.end.character)}\`${typeInfo}`,
      range: tracked.range,
    };
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
    ? widget.params.join(', ')
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
