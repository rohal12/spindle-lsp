import type { SignatureHelp, SignatureInformation, ParameterInformation } from 'vscode-languageserver';
import type { Position } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import type { ParameterDoc } from '../core/types.js';
import { splitArgs } from '@rohal12/spindle/tooling';
import { lexArguments, ArgType, type Arg } from '../core/parsing/argument-lexer.js';
import { Parameters, type ParameterSlot } from '../core/parsing/parameter-validator.js';
import { markupAt } from './markup-cursor.js';

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
 * The arguments of a call as `splitArgs` (the rule the runtime splits them
 * by) reads them with one more value after the cursor: the last one is the
 * argument being typed. A value still being typed (the cursor touches it)
 * stays the active argument; a new one starts after whitespace or a comma
 * where the runtime would split, and an open expression or string goes on.
 */
function argumentsBeingTyped(argsBefore: string): string[] {
  return splitArgs(`${argsBefore}$next`);
}

/** What a completed argument is, for the schema slot that must accept it. */
function lexArgument(text: string): Arg {
  return lexArguments(text)[0] ?? { type: ArgType.Bareword, text, start: 0, end: text.length };
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
  const cursor = markupAt(workspace, uri, position);
  // script, stylesheet and data passages are not story markup: no macro is being typed there
  if (!cursor?.passage.isMarkup) return null;

  // The innermost macro of a known name whose arguments the cursor is in (a
  // tag of the passage, or of a label or attribute value; or one not yet closed)
  const enclosing = cursor.enclosingMacro(name => !!workspace.macros.getMacro(name) || !!workspace.widgets.getWidget(name));
  if (!enclosing) return null;
  const { name: macroName, argsBefore } = enclosing;
  const typing = argumentsBeingTyped(argsBefore);
  const argument = typing.length - 1;

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
      const completed = typing.slice(0, argument).map(lexArgument);
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
      activeParameter: argument,
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
