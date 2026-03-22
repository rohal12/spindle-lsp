import type { SignatureHelp, SignatureInformation, ParameterInformation } from 'vscode-languageserver';
import type { Position } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { lexArguments } from '../core/parsing/argument-lexer.js';

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

  const lines = text.split('\n');
  if (position.line >= lines.length) return null;
  const lineText = lines[position.line];
  const textBefore = lineText.substring(0, position.character);

  // Find the enclosing macro: {macroName args...
  const macroMatch = textBefore.match(/\{(?:[#.][a-zA-Z][\w-]*\s*)*([A-Za-z][\w-]*)\s+([^}]*)$/);
  if (!macroMatch) return null;

  const macroName = macroMatch[1];
  const argsBefore = macroMatch[2];

  // Count arguments before cursor to determine active parameter
  const activeParameter = argsBefore.trim() === '' ? 0 : lexArguments(argsBefore).length;

  // Check builtin macros
  const macroInfo = workspace.macros.getMacro(macroName);
  if (macroInfo && macroInfo.parameters && macroInfo.parameters.length > 0) {
    const paramLabels = macroInfo.parameters;
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
    const paramLabels = widget.params.map(p => `@${p}`);
    return {
      signatures: [{
        label: `{${macroName} ${paramLabels.join(', ')}}`,
        documentation: `Widget defined in: ${widget.uri}`,
        parameters: paramLabels.map(p => ({ label: p })),
      }],
      activeSignature: 0,
      activeParameter,
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
