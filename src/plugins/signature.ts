import type { SignatureHelp, SignatureInformation, ParameterInformation } from 'vscode-languageserver';
import type { Position } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { lexArguments } from '../core/parsing/argument-lexer.js';
import { activeWidgetArgument } from '../core/parsing/widget-arguments.js';
import { buildLineStarts, createCodeScanner } from '../core/parsing/macro-parser.js';

// ---------------------------------------------------------------------------
// Core signature help function (no LSP dependency)
// ---------------------------------------------------------------------------

export interface SignatureHelpResult {
  signatures: Array<{
    label: string;
    documentation?: string;
    parameters: Array<{ label: string }>;
  }>;
  activeSignature: number;
  activeParameter: number;
}

/** A macro head followed by its arguments: `{name ` with an optional CSS prefix. */
const macroHeadRegex = /(?<!\\)\{(?:[#.][a-zA-Z][\w-]*\s*)*([A-Za-z][\w-]*)\s+/g;

/**
 * Find the innermost macro whose arguments are still open at the end of
 * `textBefore`: the last macro head whose balanced closing brace is not in
 * the text. Braces inside the arguments (objects, strings) are skipped the
 * way Spindle's tokenizer skips them.
 */
function findEnclosingMacro(textBefore: string): { macroName: string; argsBefore: string } | null {
  const scanner = createCodeScanner(textBefore);
  let enclosing: { macroName: string; argsBefore: string } | null = null;
  for (const match of textBefore.matchAll(macroHeadRegex)) {
    if (scanner.closeBrace(match.index + 1) !== -1) continue;
    enclosing = { macroName: match[1], argsBefore: textBefore.slice(match.index + match[0].length) };
  }
  return enclosing;
}

/**
 * Compute signature help for the macro at the given position.
 *
 * When the cursor is inside macro arguments, shows parameter information
 * and highlights the active parameter based on argument count before cursor.
 */
export function getSignatureHelp(
  uri: string,
  position: Position,
  workspace: WorkspaceModel,
): SignatureHelpResult | null {
  const text = workspace.documents.getText(uri);
  if (text === undefined) return null;

  const lineStarts = buildLineStarts(text);
  if (position.line >= lineStarts.length) return null;
  // Only the cursor's passage can hold the macro being typed
  const passageLine = workspace.passages.getPassageAt(uri, position.line)?.range.start.line ?? 0;
  const lineEnd = position.line + 1 < lineStarts.length ? lineStarts[position.line + 1] - 1 : text.length;
  const cursor = Math.min(lineStarts[position.line] + position.character, lineEnd);
  const textBefore = text.slice(lineStarts[passageLine], cursor);

  const enclosing = findEnclosingMacro(textBefore);
  if (!enclosing) return null;
  const { macroName, argsBefore } = enclosing;

  // Check builtin macros
  const macroInfo = workspace.macros.getMacro(macroName);
  if (macroInfo && macroInfo.parameters && macroInfo.parameters.length > 0) {
    const paramLabels = macroInfo.parameters;
    // Count arguments before cursor to determine active parameter
    const activeParameter = argsBefore.trim() === '' ? 0 : lexArguments(argsBefore).length;
    return {
      signatures: [{
        label: `{${macroName} ${paramLabels.join(' ')}}`,
        documentation: macroInfo.description ?? undefined,
        parameters: paramLabels.map(p => ({ label: p })),
      }],
      activeSignature: 0,
      activeParameter,
    };
  }

  // Check widgets
  const widget = workspace.widgets.getWidget(macroName);
  if (widget && widget.params.length > 0) {
    const paramLabels = widget.params;
    return {
      signatures: [{
        label: `{${macroName} ${paramLabels.join(', ')}}`,
        documentation: `Widget defined in: ${widget.uri}`,
        parameters: paramLabels.map(p => ({ label: p })),
      }],
      activeSignature: 0,
      // Widget arguments are split the way Spindle's WidgetInvocation does
      activeParameter: activeWidgetArgument(argsBefore),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Plugin wrapper (LSP integration)
// ---------------------------------------------------------------------------

export const signaturePlugin: SpindlePlugin = {
  id: 'signature',
  capabilities: {
    signatureHelpProvider: {
      triggerCharacters: [' ', '"', "'"],
    },
  },
  initialize(ctx: PluginContext) {
    ctx.connection.onSignatureHelp((params): SignatureHelp | null => {
      const result = getSignatureHelp(
        params.textDocument.uri,
        { line: params.position.line, character: params.position.character },
        ctx.workspace,
      );
      if (!result) return null;

      const signatures: SignatureInformation[] = result.signatures.map(sig => ({
        label: sig.label,
        documentation: sig.documentation,
        parameters: sig.parameters.map(p => ({ label: p.label }) as ParameterInformation),
      }));

      return {
        signatures,
        activeSignature: result.activeSignature,
        activeParameter: result.activeParameter,
      };
    });
  },
};
