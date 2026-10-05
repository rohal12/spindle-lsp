import type { SignatureHelp, SignatureInformation, ParameterInformation } from 'vscode-languageserver';
import type { Position } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { lexArguments } from '../core/parsing/argument-lexer.js';
import { Parameters, type ParameterSlot } from '../core/parsing/parameter-validator.js';
import { activeWidgetArgument } from '../core/parsing/widget-arguments.js';
import { buildLineStarts, createCodeScanner, SELECTOR_PATTERN } from '../core/parsing/macro-parser.js';

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
const macroHeadRegex = new RegExp(String.raw`(?<!\\)\{(?:${SELECTOR_PATTERN} )?([A-Za-z][\w-]*)\s+`, 'g');

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

function slotLabel(slot: ParameterSlot): string {
  if (slot.repeat) return `...${slot.label}`;
  return slot.optional ? `[${slot.label}]` : slot.label;
}

/**
 * One signature per distinct positional sequence of the macro's schema
 * variants, using the same schema semantics as the parameter validator.
 */
function describeSignatures(
  macroName: string,
  variants: string[],
  documentation: string | undefined,
): SignatureHelpResult['signatures'] {
  let sequences: ParameterSlot[][];
  try {
    sequences = new Parameters(variants).describe();
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const signatures: SignatureHelpResult['signatures'] = [];
  for (const sequence of sequences) {
    const labels = sequence.map(slotLabel);
    const label = `{${[macroName, ...labels].join(' ')}}`;
    if (seen.has(label)) continue;
    seen.add(label);
    signatures.push({ label, documentation, parameters: labels.map(l => ({ label: l })) });
  }
  return signatures;
}

/**
 * Index of the argument being typed. A token still being typed (the cursor
 * touches it) keeps its own index; the next index starts at whitespace or a
 * comma, or inside a token the lexer has not completed (an open string).
 */
function activeMacroArgument(argsBefore: string): number {
  if (argsBefore.trim() === '') return 0;
  const lexed = lexArguments(argsBefore);
  const tail = argsBefore.slice(lexed.length > 0 ? lexed[lexed.length - 1].end : 0);
  if (tail !== '') return lexed.length;
  return Math.max(lexed.length - 1, 0);
}

/** The first signature with a position for the active argument. */
function pickSignature(signatures: SignatureHelpResult['signatures'], active: number): number {
  const fits = signatures.findIndex(sig => {
    const last = sig.parameters[sig.parameters.length - 1];
    return sig.parameters.length > active || (last?.label.startsWith('...') ?? false);
  });
  return fits === -1 ? 0 : fits;
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
    const signatures = describeSignatures(macroName, macroInfo.parameters, macroInfo.description ?? undefined);
    if (signatures.length > 0) {
      const argument = activeMacroArgument(argsBefore);
      const activeSignature = pickSignature(signatures, argument);
      const { parameters } = signatures[activeSignature];
      // A repeated position stays active for every further argument
      const repeats = parameters[parameters.length - 1]?.label.startsWith('...') ?? false;
      const activeParameter = repeats ? Math.min(argument, parameters.length - 1) : argument;
      return { signatures, activeSignature, activeParameter };
    }
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

/** Parameter labels as offsets into the signature label, so equal labels stay distinct. */
function parameterInformation(sig: SignatureHelpResult['signatures'][number]): ParameterInformation[] {
  let from = sig.label.indexOf(' ') + 1;
  return sig.parameters.map(p => {
    const start = sig.label.indexOf(p.label, from);
    if (start < 0) return { label: p.label };
    from = start + p.label.length;
    return { label: [start, from] };
  });
}

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
        parameters: parameterInformation(sig),
      }));

      return {
        signatures,
        activeSignature: result.activeSignature,
        activeParameter: result.activeParameter,
      };
    });
  },
};
