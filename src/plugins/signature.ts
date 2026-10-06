import type { SignatureHelp, SignatureInformation, ParameterInformation } from 'vscode-languageserver';
import type { Position } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import type { ParameterDoc } from '../core/types.js';
import { lexArguments, type Arg } from '../core/parsing/argument-lexer.js';
import { Parameters, type ParameterSlot } from '../core/parsing/parameter-validator.js';
import { activeWidgetArgument } from '../core/parsing/widget-arguments.js';
import { buildLineStarts, createCodeScanner, SELECTOR_PATTERN } from '../core/parsing/macro-parser.js';
import type { BraceReading } from '../core/parsing/code-scanner.js';
import { inAttributeValue } from '../core/parsing/html-scanner.js';
import { isMarkupPassage } from '../core/parsing/passage-parser.js';

// ---------------------------------------------------------------------------
// Core signature help function (no LSP dependency)
// ---------------------------------------------------------------------------

export interface SignatureHelpResult {
  signatures: Array<{
    label: string;
    documentation?: string;
    parameters: Array<{ label: string; documentation?: string }>;
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
function findEnclosingMacro(textBefore: string, reading: BraceReading): { macroName: string; argsBefore: string } | null {
  const scanner = createCodeScanner(textBefore, reading);
  let enclosing: { macroName: string; argsBefore: string } | null = null;
  for (const match of textBefore.matchAll(macroHeadRegex)) {
    if (scanner.closeBrace(match.index + 1) !== -1) continue;
    enclosing = { macroName: match[1], argsBefore: textBefore.slice(match.index + match[0].length) };
  }
  return enclosing;
}

function slotLabel(slot: ParameterSlot, name: string): string {
  if (slot.repeat) return `...${name}`;
  return slot.optional ? `[${name}]` : name;
}

/** A signature with the schema slots it was built from, used to follow typed arguments. */
interface DescribedSignature {
  signature: SignatureHelpResult['signatures'][number];
  slots: ParameterSlot[];
}

/**
 * One signature per distinct positional sequence of the macro's schema
 * variants, using the same schema semantics as the parameter validator.
 * Parameters are named by the macro's `parameterDocs` (by position) and fall
 * back to the slot's type name; the type is always given in the documentation.
 */
function describeSignatures(
  macroName: string,
  variants: string[],
  documentation: string | undefined,
  parameterDocs: ParameterDoc[] = [],
): DescribedSignature[] {
  let sequences: ParameterSlot[][];
  try {
    sequences = new Parameters(variants).describe();
  } catch {
    return [];
  }
  const build = (slots: ParameterSlot[], withTypes: boolean): DescribedSignature => {
    const parameters = slots.map((slot, index) => {
      const doc = parameterDocs[index];
      const name = doc?.name ?? slot.label;
      const typeNote = `Type: ${slot.label}`;
      return {
        label: slotLabel(slot, withTypes && name !== slot.label ? `${name}: ${slot.label}` : name),
        documentation: doc?.documentation ? `${doc.documentation}\n\n${typeNote}` : typeNote,
      };
    });
    const label = `{${[macroName, ...parameters.map(p => p.label)].join(' ')}}`;
    return { signature: { label, documentation, parameters }, slots };
  };
  const typeKey = (slots: ParameterSlot[]) => slots.map(slot => `${slotLabel(slot, slot.label)}`).join(' ');
  // Alternatives that differ only in slot types share their positional names;
  // they are told apart by showing the types, and identical ones are dropped
  const unique = new Map<string, ParameterSlot[]>();
  for (const slots of sequences) if (!unique.has(typeKey(slots))) unique.set(typeKey(slots), slots);
  const plain = [...unique.values()].map(slots => build(slots, false));
  const labelCounts = new Map<string, number>();
  for (const d of plain) labelCounts.set(d.signature.label, (labelCounts.get(d.signature.label) ?? 0) + 1);
  return plain.map(d => (labelCounts.get(d.signature.label)! > 1 ? build(d.slots, true) : d));
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

/** The slot an argument at `index` would occupy, with a trailing repeat covering the rest. */
function slotAt(slots: ParameterSlot[], index: number): ParameterSlot | undefined {
  if (index < slots.length) return slots[index];
  const last = slots[slots.length - 1];
  return last?.repeat ? last : undefined;
}

/**
 * The signature that still describes what has been typed: every completed
 * argument before the active one must be accepted by its slot (judged by the
 * validator's own type checks), and the active position must exist. When no
 * alternative fits both, prefer one that accepts the typed prefix, then one
 * that has a position for the active argument.
 */
function pickSignature(described: DescribedSignature[], completed: Arg[], active: number): number {
  const accepts = (d: DescribedSignature) => completed.every((arg, i) => slotAt(d.slots, i)?.accepts(arg) ?? false);
  const hasSlot = (d: DescribedSignature) => slotAt(d.slots, active) !== undefined;
  for (const test of [
    (d: DescribedSignature) => accepts(d) && hasSlot(d),
    accepts,
    hasSlot,
  ]) {
    const index = described.findIndex(test);
    if (index !== -1) return index;
  }
  return 0;
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
  const cursorPassage = workspace.passages.getPassageAt(uri, position.line);
  // script, stylesheet and data passages are not story markup: no macro is being typed there
  if (cursorPassage && !isMarkupPassage(cursorPassage)) return null;
  const passageLine = cursorPassage?.range.start.line ?? 0;
  const lineEnd = position.line + 1 < lineStarts.length ? lineStarts[position.line + 1] - 1 : text.length;
  const cursor = Math.min(lineStarts[position.line] + position.character, lineEnd);
  // Spindle outputs a macro in an HTML attribute value as text (SP103): nothing is being called there
  if (cursor > 0 && inAttributeValue(text, cursor - 1)) return null;
  const textBefore = text.slice(lineStarts[passageLine], cursor);

  const enclosing = findEnclosingMacro(textBefore, workspace.capabilities);
  if (!enclosing) return null;
  const { macroName, argsBefore } = enclosing;

  // Check builtin macros
  const macroInfo = workspace.macros.getMacro(macroName);
  if (macroInfo && macroInfo.parameters && macroInfo.parameters.length > 0) {
    const described = describeSignatures(
      macroName,
      macroInfo.parameters,
      macroInfo.description ?? undefined,
      macroInfo.parameterDocs,
    );
    if (described.length > 0) {
      const argument = activeMacroArgument(argsBefore);
      const completed = lexArguments(argsBefore).slice(0, argument);
      const activeSignature = pickSignature(described, completed, argument);
      const signatures = described.map(d => d.signature);
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
    if (start < 0) return { label: p.label, documentation: p.documentation };
    from = start + p.label.length;
    return { label: [start, from], documentation: p.documentation };
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
