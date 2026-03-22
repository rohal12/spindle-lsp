import type { Diagnostic, MacroNode } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { DiagnosticCode, getSeverity } from '../core/diagnostic-codes.js';
import type { DiagnosticCodeValue } from '../core/diagnostic-codes.js';
import { parseMacros, pairMacros } from '../core/parsing/macro-parser.js';
import { lexArguments } from '../core/parsing/argument-lexer.js';
import { Parameters } from '../core/parsing/parameter-validator.js';
import { parseLinks } from '../core/parsing/link-parser.js';

// ---------------------------------------------------------------------------
// Core diagnostic function (no LSP dependency)
// ---------------------------------------------------------------------------

/**
 * Compute all diagnostics for a single document within the workspace context.
 *
 * Checks:
 *  - Macro validation (SP100, SP101, SP104, SP107, SP114, SP115)
 *  - Argument/parameter validation (SP108, SP109, SP110, SP111, SP112)
 *  - Variable validation (SP200, SP202)
 *  - Link/widget validation (SP300, SP301)
 */
export function computeDiagnostics(uri: string, workspace: WorkspaceModel): Diagnostic[] {
  try {
    const text = workspace.documents.getText(uri);
    if (text === undefined) return [];

    const passages = workspace.passages.getPassagesInDocument(uri);
    if (passages.length === 0) return [];

    const diagnostics: Diagnostic[] = [];

    // Parse macros for the whole document
    const macros = parseMacros(text);
    pairMacros(macros, (name) => workspace.macros.isBlock(name));

    // Collect all passage names across workspace for link validation
    const allPassages = workspace.passages.getAllPassages();
    const passageNames = new Set(allPassages.map(p => p.name));

    // Each validation step is wrapped individually so that a failure
    // in one category still allows the others to produce diagnostics.

    try {
      validateMacros(macros, workspace, diagnostics);
    } catch {
      // Macro validation failed — continue with other checks
    }

    try {
      validateArguments(macros, workspace, passageNames, diagnostics);
    } catch {
      // Argument validation failed — continue
    }

    try {
      validateVariables(uri, workspace, diagnostics);
    } catch {
      // Variable validation failed — continue
    }

    try {
      validateLinks(text, passages, passageNames, diagnostics);
    } catch {
      // Link validation failed — continue
    }

    try {
      validateWidgetInvocations(macros, workspace, diagnostics);
    } catch {
      // Widget validation failed — continue
    }

    return diagnostics;
  } catch {
    // Catastrophic failure — return empty diagnostics rather than crashing
    return [];
  }
}

// ---------------------------------------------------------------------------
// Macro validation (SP100, SP101, SP104, SP107, SP114, SP115)
// ---------------------------------------------------------------------------

function validateMacros(
  macros: MacroNode[],
  workspace: WorkspaceModel,
  diagnostics: Diagnostic[],
): void {
  for (let curIndex = 0; curIndex < macros.length; curIndex++) {
    const macro = macros[curIndex];
    const info = workspace.macros.getMacro(macro.name);

    if (info) {
      // Known macro
      if (info.block) {
        // SP101: unmatched container
        if (macro.open && macro.pair === -1) {
          diagnostics.push(makeDiag(
            macro.range,
            DiagnosticCode.MalformedContainer,
            `Malformed container: no matching {/${macro.name}}`,
          ));
        } else if (!macro.open && macro.pair === -1) {
          diagnostics.push(makeDiag(
            macro.range,
            DiagnosticCode.MalformedContainer,
            `Malformed container: no matching {${macro.name}}`,
          ));
        }

        // SP114/SP115: children constraints
        if (info.children && info.children.length > 0 && macro.open && macro.pair !== -1) {
          validateChildren(macros, curIndex, macro, info.children, workspace, diagnostics);
        }
      } else {
        // SP104: closing tag on non-container
        if (!macro.open) {
          diagnostics.push(makeDiag(
            macro.range,
            DiagnosticCode.IllegalClosingTag,
            `Illegal closing tag: {${macro.name}} is not a container`,
          ));
        }
      }

      // SP107: parents constraint
      if (info.parents && info.parents.length > 0 && macro.open) {
        if (!isInsideParent(macros, curIndex, info.parents, workspace)) {
          const parentList = info.parents.join(', ');
          diagnostics.push(makeDiag(
            macro.range,
            DiagnosticCode.InvalidChildren,
            `Invalid: {${macro.name}} can only be inside {${parentList}}`,
          ));
        }
      }
    } else {
      // Check if it's a user-defined widget before flagging SP100
      const widget = workspace.widgets.getWidget(macro.name);
      if (!widget && macro.open) {
        // SP100: unrecognized macro
        diagnostics.push(makeDiag(
          macro.range,
          DiagnosticCode.UndefinedMacro,
          `Unrecognized macro: {${macro.name}}`,
        ));
      }
    }
  }
}

/**
 * Check whether the macro at `index` is inside one of the allowed parent containers.
 */
function isInsideParent(
  macros: MacroNode[],
  index: number,
  parents: string[],
  workspace: WorkspaceModel,
): boolean {
  const parentSet = new Set(parents.map(p => p.toLowerCase()));

  // Walk backwards to find an enclosing container
  for (let i = index - 1; i >= 0; i--) {
    const candidate = macros[i];
    if (!candidate.open) continue;

    const candidateInfo = workspace.macros.getMacro(candidate.name);
    if (!candidateInfo?.block) continue;

    // Check if the candidate's pair extends past our macro
    if (candidate.pair !== -1 && candidate.pair > index) {
      // We are inside this container
      if (parentSet.has(candidate.name.toLowerCase())) {
        return true;
      }
      // We're inside a different container — keep looking for allowed parents
    }
  }

  return false;
}

/**
 * Validate children constraints for a paired container macro.
 */
function validateChildren(
  macros: MacroNode[],
  curIndex: number,
  parentMacro: MacroNode,
  childConstraints: Array<{ name: string; min?: number; max?: number }>,
  workspace: WorkspaceModel,
  diagnostics: Diagnostic[],
): void {
  const children: Record<string, number> = Object.create(null);
  const startIndex = curIndex + 1;
  const endIndex = parentMacro.pair;

  for (let i = startIndex; i < endIndex; i++) {
    const child = macros[i];
    const childInfo = workspace.macros.getMacro(child.name);

    if (!childInfo) continue;

    // Skip contents of nested containers
    if (childInfo.block && child.open && child.pair !== -1) {
      i = child.pair;
      continue;
    }

    // Count direct children that match constraints
    for (const constraint of childConstraints) {
      if (constraint.name === child.name) {
        children[child.name] = (children[child.name] ?? 0) + 1;
      }
    }
  }

  // Check constraints
  for (const constraint of childConstraints) {
    const count = children[constraint.name] ?? 0;

    if (constraint.max !== undefined && count > constraint.max) {
      diagnostics.push(makeDiag(
        parentMacro.range,
        DiagnosticCode.ChildMaxExceeded,
        `Too many {${constraint.name}} in {${parentMacro.name}} (max ${constraint.max}, found ${count})`,
      ));
    }

    if (constraint.min !== undefined && count < constraint.min) {
      diagnostics.push(makeDiag(
        parentMacro.range,
        DiagnosticCode.ChildMinNotMet,
        `Too few {${constraint.name}} in {${parentMacro.name}} (min ${constraint.min}, found ${count})`,
      ));
    }
  }
}

// ---------------------------------------------------------------------------
// Argument / parameter validation (SP108, SP109, SP110, SP111, SP112)
// ---------------------------------------------------------------------------

function validateArguments(
  macros: MacroNode[],
  workspace: WorkspaceModel,
  passageNames: Set<string>,
  diagnostics: Diagnostic[],
): void {
  for (const macro of macros) {
    if (!macro.open) continue;

    const info = workspace.macros.getMacro(macro.name);
    if (!info) continue;
    if (info.skipArgs) continue;
    if (!info.parameters) continue;

    const rawArgs = macro.rawArgs ?? '';
    const args = lexArguments(rawArgs);

    const params = new Parameters(info.parameters);

    // SP108: empty parameters but received args
    if (params.isEmpty()) {
      if (args.length > 0) {
        diagnostics.push(makeDiag(
          macro.range,
          DiagnosticCode.ExpectedNoArguments,
          `Expected no arguments for {${macro.name}}, got ${args.length}`,
        ));
      }
      continue;
    }

    const stateInfo = { passages: Array.from(passageNames) };
    const result = params.validate(args, stateInfo);

    if (result.variantIndex === null) {
      // No variant matched at all — covered by isEmpty check above
      continue;
    }

    // SP109: parameter type errors
    for (const error of result.errors) {
      // Determine if it's a "too many" error or a type error
      if (error.message.startsWith('Too many arguments')) {
        diagnostics.push(makeDiag(
          macro.range,
          DiagnosticCode.TooManyArguments,
          `{${macro.name}}: ${error.message}`,
        ));
      } else {
        diagnostics.push(makeDiag(
          macro.range,
          DiagnosticCode.ParameterTypeError,
          `{${macro.name}}: ${error.message}`,
        ));
      }
    }

    // SP110: parameter warnings
    for (const warning of result.warnings) {
      diagnostics.push(makeDiag(
        macro.range,
        DiagnosticCode.ParameterWarning,
        `{${macro.name}}: ${warning.message}`,
      ));
    }
  }
}

// ---------------------------------------------------------------------------
// Variable validation (SP200, SP202)
// ---------------------------------------------------------------------------

function validateVariables(
  uri: string,
  workspace: WorkspaceModel,
  diagnostics: Diagnostic[],
): void {
  if (!workspace.variables.hasStoryVariables()) {
    // SP202: no StoryVariables passage
    // Only emit once per document, and only if there are variable usages
    const undeclared = workspace.variables.getUndeclared(uri);
    // Even with no StoryVariables, getUndeclared returns all usages since nothing is declared
    // Check if there are any variable usages at all
    const text = workspace.documents.getText(uri);
    if (text && /\$[A-Za-z_$]/.test(text)) {
      // Check if there are non-special passages with variable usages
      const passages = workspace.passages.getPassagesInDocument(uri);
      const hasVarUsage = passages.some(p => {
        const excluded = new Set(['StoryVariables', 'StoryInit', 'StoryData', 'StoryScript', 'StoryInterface']);
        return !excluded.has(p.name) && !p.tags?.includes('script') && !p.tags?.includes('stylesheet');
      });
      if (hasVarUsage) {
        diagnostics.push(makeDiag(
          passages[0].range,
          DiagnosticCode.NoStoryVariables,
          'No StoryVariables passage found. Declare all story variables with default values in a StoryVariables passage.',
        ));
      }
    }
    return;
  }

  // SP200: undeclared variable
  const undeclared = workspace.variables.getUndeclared(uri);
  for (const u of undeclared) {
    diagnostics.push(makeDiag(
      u.range,
      DiagnosticCode.UndeclaredVariable,
      `Variable '$${u.name}' is not declared in StoryVariables`,
    ));
  }
}

// ---------------------------------------------------------------------------
// Link validation (SP300)
// ---------------------------------------------------------------------------

function validateLinks(
  text: string,
  passages: Array<{ name: string; range: import('../core/types.js').Range }>,
  passageNames: Set<string>,
  diagnostics: Diagnostic[],
): void {
  const links = parseLinks(text);
  for (const link of links) {
    if (!passageNames.has(link.name)) {
      diagnostics.push(makeDiag(
        link.range,
        DiagnosticCode.BrokenPassageLink,
        `Passage "${link.name}" not found in workspace`,
      ));
    }
  }
}

// ---------------------------------------------------------------------------
// Widget invocation validation (SP301)
// ---------------------------------------------------------------------------

function validateWidgetInvocations(
  macros: MacroNode[],
  workspace: WorkspaceModel,
  diagnostics: Diagnostic[],
): void {
  for (const macro of macros) {
    if (!macro.open) continue;

    // Skip if it's a known macro (not a widget)
    const info = workspace.macros.getMacro(macro.name);
    if (info) continue;

    const widget = workspace.widgets.getWidget(macro.name);
    if (!widget) continue;

    // Count arguments provided
    const rawArgs = macro.rawArgs ?? '';
    const argCount = rawArgs.trim() === '' ? 0 : lexArguments(rawArgs).length;
    const expectedCount = widget.params.length;

    if (argCount !== expectedCount) {
      diagnostics.push(makeDiag(
        macro.range,
        DiagnosticCode.WidgetArgCountMismatch,
        `Widget {${macro.name}} expects ${expectedCount} argument(s), got ${argCount}`,
      ));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiag(
  range: import('../core/types.js').Range,
  code: DiagnosticCodeValue,
  message: string,
): Diagnostic {
  return {
    range,
    message,
    severity: getSeverity(code),
    code,
    source: 'spindle',
  };
}

// ---------------------------------------------------------------------------
// Plugin wrapper (LSP integration)
// ---------------------------------------------------------------------------

function toLspDiagnostic(d: Diagnostic): import('vscode-languageserver').Diagnostic {
  const severityMap = {
    error: 1,
    warning: 2,
    info: 3,
    hint: 4,
  } as const;

  return {
    range: {
      start: { line: d.range.start.line, character: d.range.start.character },
      end: { line: d.range.end.line, character: d.range.end.character },
    },
    severity: severityMap[d.severity],
    code: d.code,
    source: d.source,
    message: d.message,
  };
}

export const diagnosticsPlugin: SpindlePlugin = {
  id: 'diagnostics',
  capabilities: {},
  initialize(ctx: PluginContext) {
    const publishDiagnostics = () => {
      for (const uri of ctx.workspace.documents.getUris()) {
        const diags = computeDiagnostics(uri, ctx.workspace);
        ctx.connection.sendDiagnostics({
          uri,
          diagnostics: diags.map(d => toLspDiagnostic(d)),
        });
      }
    };

    ctx.workspace.on('modelReady', publishDiagnostics);
    ctx.workspace.on('documentChanged', (uri: string) => {
      const diags = computeDiagnostics(uri, ctx.workspace);
      ctx.connection.sendDiagnostics({
        uri,
        diagnostics: diags.map(d => toLspDiagnostic(d)),
      });
    });
  },
};
