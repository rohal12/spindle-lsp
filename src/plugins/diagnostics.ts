import type { Diagnostic, MacroNode, Passage } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { DiagnosticCode, getSeverity } from '../core/diagnostic-codes.js';
import type { DiagnosticCodeValue } from '../core/diagnostic-codes.js';
import { parseMacros, pairMacros, buildLineStarts, offsetToPosition } from '../core/parsing/macro-parser.js';
import { lexArguments, ArgType, type Arg } from '../core/parsing/argument-lexer.js';
import { splitWidgetArguments } from '../core/parsing/widget-arguments.js';
import { Parameters } from '../core/parsing/parameter-validator.js';
import { parseLinks } from '../core/parsing/link-parser.js';
import { isScriptOrStylesheetPassage } from '../core/parsing/passage-parser.js';
import { isMacroSource } from '../core/workspace/macro-sources.js';

// ---------------------------------------------------------------------------
// Core diagnostic function (no LSP dependency)
// ---------------------------------------------------------------------------

/**
 * Compute all diagnostics for a single document within the workspace context.
 *
 * Checks:
 *  - Macro validation (SP100, SP101, SP104, SP107, SP114, SP115)
 *  - Argument/parameter validation (SP108, SP109, SP110, SP111, SP112)
 *  - Variable validation (SP200, SP202, SP203, SP204, SP206)
 *  - Temporaries assigned inside {for} (SP205)
 *  - Link/widget validation (SP300, SP301, SP302, SP303)
 */
export interface DiagnosticOptions {
  maxLineLength?: number;
}

export function computeDiagnostics(uri: string, workspace: WorkspaceModel, options?: DiagnosticOptions): Diagnostic[] {
  // Don't emit any diagnostics until the full workspace scan is done.
  // Before that, passage/variable/widget indices are incomplete and
  // would produce false positives for cross-file references.
  if (!workspace.initialized) return [];

  try {
    const text = workspace.documents.getText(uri);
    if (text === undefined) return [];

    const passages = workspace.passages.getPassagesInDocument(uri);
    if (passages.length === 0) return [];

    const diagnostics: Diagnostic[] = [];

    // Script and stylesheet passages hold JS/CSS, not story markup: blank
    // their bodies (keeping offsets) before parsing macros and links.
    const markupText = maskScriptAndStylesheetPassages(text, passages);

    // Parse macros for the whole document
    const macros = parseMacros(markupText);
    pairMacros(
      macros,
      (name) => workspace.isContainer(name),
      passages.map(p => p.range.start.line),
    );

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
      validateLinks(markupText, passages, passageNames, diagnostics);
    } catch {
      // Link validation failed — continue
    }

    try {
      validateWidgetInvocations(macros, workspace, diagnostics);
    } catch {
      // Widget validation failed — continue
    }

    try {
      validateArrayMemberAccess(uri, workspace, diagnostics);
    } catch {
      // Array member validation failed — continue
    }

    try {
      validateLoopTemporaries(uri, text, macros, workspace, diagnostics);
    } catch {
      // Loop temporary validation failed — continue
    }

    try {
      validateWidgetIncludes(text, macros, workspace, diagnostics);
    } catch {
      // Include validation failed — continue
    }

    try {
      validateUnusedWidgets(uri, workspace, diagnostics);
    } catch {
      // Unused widget validation failed — continue
    }

    if (options?.maxLineLength) {
      try {
        validateLineLength(text, passages, options.maxLineLength, diagnostics);
      } catch {
        // Line-length validation failed — continue
      }
    }

    return diagnostics;
  } catch {
    // Catastrophic failure — return empty diagnostics rather than crashing
    return [];
  }
}

/**
 * Replace the body of every script/stylesheet passage with spaces, keeping
 * line breaks so that offsets and positions are unchanged.
 */
function maskScriptAndStylesheetPassages(text: string, passages: Passage[]): string {
  const excluded = passages.filter(isScriptOrStylesheetPassage);
  if (excluded.length === 0) return text;

  const lines = text.split('\n');
  for (const passage of excluded) {
    const last = Math.min(passage.range.end.line, lines.length - 1);
    for (let i = passage.range.start.line + 1; i <= last; i++) {
      lines[i] = lines[i].replace(/[^\r]/g, ' ');
    }
  }
  return lines.join('\n');
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

    // Neither a macro nor a user-defined widget
    if (!info && !workspace.widgets.getWidget(macro.name)) {
      if (macro.open) {
        // SP100: unrecognized macro
        diagnostics.push(makeDiag(
          macro.range,
          DiagnosticCode.UndefinedMacro,
          `Unrecognized macro: {${macro.name}}`,
        ));
      }
      continue;
    }

    if (workspace.isContainer(macro.name)) {
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
      if (info?.children && info.children.length > 0 && macro.open && macro.pair !== -1) {
        validateChildren(macros, curIndex, macro, info.children, workspace, diagnostics);
      }
    } else if (!macro.open) {
      // SP104: closing tag on non-container
      diagnostics.push(makeDiag(
        macro.range,
        DiagnosticCode.IllegalClosingTag,
        `Illegal closing tag: {${macro.name}} is not a container`,
      ));
    }

    // SP107: parents constraint
    if (info?.parents && info.parents.length > 0 && macro.open) {
      const parentList = info.parents.join(', ');
      if (DIRECT_CHILD_MACROS.has(macro.name.toLowerCase())) {
        const enclosing = innermostContainer(macros, curIndex, workspace);
        const parentSet = new Set(info.parents.map(p => p.toLowerCase()));
        if (!enclosing || !parentSet.has(enclosing.name.toLowerCase())) {
          const where = enclosing ? `, not inside {${enclosing.name}}` : '';
          diagnostics.push(makeDiag(
            macro.range,
            DiagnosticCode.InvalidChildren,
            `Invalid: {${macro.name}} can only be directly inside {${parentList}}${where}`,
          ));
        }
      } else if (!isInsideParent(macros, curIndex, info.parents, workspace)) {
        diagnostics.push(makeDiag(
          macro.range,
          DiagnosticCode.InvalidChildren,
          `Invalid: {${macro.name}} can only be inside {${parentList}}`,
        ));
      }
    }
  }
}

/**
 * Macros that only work as direct children of their parent container.
 *
 * Spindle's AST builder attaches a branch ({elseif}/{else}, {case}/{default},
 * {next}) to the block on top of its stack and throws when that block is
 * not the branch's parent, so a branch nested in another container inside
 * its parent is an error. {listbox} and {cycle} read their {option}s from
 * their direct children only, so a nested {option} is silently dropped.
 *
 * Other children, such as {stop}, reach their parent through React context
 * and may sit anywhere inside it.
 */
const DIRECT_CHILD_MACROS = new Set(['elseif', 'else', 'case', 'default', 'next', 'option']);

/**
 * The innermost container enclosing the macro at `index`, as on Spindle's
 * AST stack: built-in and custom block macros as well as block widgets.
 * Containers without a closing tag are skipped; SP101 reports them.
 */
function innermostContainer(
  macros: MacroNode[],
  index: number,
  workspace: WorkspaceModel,
): MacroNode | undefined {
  // Containers are paired with a stack, so the nearest opener whose closing
  // tag lies past `index` is the innermost one.
  for (let i = index - 1; i >= 0; i--) {
    const candidate = macros[i];
    if (!candidate.open || candidate.pair <= index) continue;
    if (workspace.isContainer(candidate.name)) return candidate;
  }
  return undefined;
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

    // Skip contents of nested containers, block widgets included
    if (child.open && child.pair !== -1 && workspace.isContainer(child.name)) {
      i = child.pair;
      continue;
    }

    if (!workspace.macros.getMacro(child.name)) continue;

    // Count direct children that match constraints. Like macro lookup,
    // matching ignores capitalization: Spindle lower-cases macro names.
    const childKey = child.name.toLowerCase();
    if (childConstraints.some(c => c.name.toLowerCase() === childKey)) {
      children[childKey] = (children[childKey] ?? 0) + 1;
    }
  }

  // Check constraints
  for (const constraint of childConstraints) {
    const count = children[constraint.name.toLowerCase()] ?? 0;

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
    const name = macro.name.toLowerCase();
    const args = name === 'include'
      ? targetArguments(includeExpression(rawArgs))
      : name === 'goto'
        ? targetArguments(rawArgs.trim())
        : lexArguments(rawArgs);

    // A malformed parameter schema (e.g. from a project config) only
    // disables argument checks for its own macro.
    let params: Parameters;
    try {
      params = new Parameters(info.parameters);
    } catch {
      continue;
    }

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

/**
 * The arguments of `{goto}` / `{include}` as Spindle reads them: the target
 * (for `{include}`, minus an `inline` keyword) is evaluated as a single
 * expression, falling back to the raw text when evaluation throws. A target
 * such as `"Chapter " + $n` or a bare `Chapter 1` therefore counts as one
 * argument, not several lexer tokens.
 */
function targetArguments(expr: string): Arg[] {
  if (expr === '') return [];
  const args = lexArguments(expr);
  if (args.length === 1) return args;
  return [{ type: ArgType.Expression, text: expr, start: 0, end: expr.length }];
}

/** The target expression of `{include}`: its arguments minus the `inline` keyword. */
function includeExpression(rawArgs: string): string {
  return rawArgs.replace(/\binline\b/, '').trim();
}

// ---------------------------------------------------------------------------
// Variable validation (SP200, SP202, SP203, SP204)
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
  } else {
    // SP200: undeclared variable
    const undeclared = workspace.variables.getUndeclared(uri);
    for (const u of undeclared) {
      diagnostics.push(makeDiag(
        u.range,
        DiagnosticCode.UndeclaredVariable,
        `Variable '$${u.name}' is not declared in StoryVariables`,
      ));
    }

    // SP204: null variable value in StoryVariables
    // Only emit on the document that contains StoryVariables
    const storyVars = workspace.passages.getStoryVariables();
    if (storyVars && storyVars.uri === uri) {
      for (const nd of workspace.variables.getNullDeclarations()) {
        diagnostics.push(makeDiag(
          nd.range,
          DiagnosticCode.NullVariableValue,
          `Variable '$${nd.name}' is set to null. Spindle does not support null — use a valid default (number, string, boolean, array, or object).`,
        ));
      }
    }
  }

  // SP203: undeclared transient variable (independent of StoryVariables)
  if (workspace.variables.hasStoryTransients()) {
    const undeclaredTransient = workspace.variables.getUndeclaredTransient(uri);
    for (const u of undeclaredTransient) {
      diagnostics.push(makeDiag(
        u.range,
        DiagnosticCode.UndeclaredTransient,
        `Transient variable '%${u.name}' is not declared in StoryTransients`,
      ));
    }

    // SP204: null transient value in StoryTransients
    const storyTransients = workspace.passages.getStoryTransients();
    if (storyTransients && storyTransients.uri === uri) {
      for (const nd of workspace.variables.getNullTransientDeclarations()) {
        diagnostics.push(makeDiag(
          nd.range,
          DiagnosticCode.NullVariableValue,
          `Transient variable '%${nd.name}' is set to null. Spindle does not support null — use a valid default (number, string, boolean, array, or object).`,
        ));
      }
    }
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

    // Count arguments the way Spindle's WidgetInvocation splits them
    const argCount = splitWidgetArguments(macro.rawArgs ?? '').length;
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
// Array member access validation (SP206)
// ---------------------------------------------------------------------------

/**
 * Flag `$var.name` where `$var` defaults to an array literal in StoryVariables
 * (or `%var.name` in StoryTransients) and `name` is not an array property.
 * Spindle evaluates `$var.name` as plain JavaScript property access, so the
 * result is always `undefined`.
 */
function validateArrayMemberAccess(
  uri: string,
  workspace: WorkspaceModel,
  diagnostics: Diagnostic[],
): void {
  for (const a of workspace.variables.getArrayMemberAccesses(uri)) {
    const passage = a.sigil === '%' ? 'StoryTransients' : 'StoryVariables';
    const ref = `${a.sigil}${a.name}`;
    diagnostics.push(makeDiag(
      a.range,
      DiagnosticCode.ArrayMemberAccess,
      `'${ref}' is declared as an array in ${passage}, and arrays have no '${a.member}' property: ` +
        `'${ref}.${a.member}' is always undefined. ` +
        `If you meant to test membership, use ${ref}.includes("${a.member}").`,
    ));
  }
}

// ---------------------------------------------------------------------------
// Temporaries assigned inside {for} (SP205)
// ---------------------------------------------------------------------------

/**
 * Containers whose body runs when the user clicks, not when the loop renders.
 * Assigning a temporary there records the clicked iteration's value, which is
 * the normal way to hand a value out of a loop.
 */
const DEFERRED_CONTAINERS = new Set(['link', 'button']);

interface TemporaryTarget {
  /** Name without the `_` sigil. */
  name: string;
  /** Offset of the `_` within the macro's raw arguments. */
  offset: number;
}

/** Matches a `_name` temporary reference, using Spindle's own boundary rule. */
function temporaryRefRegex(name?: string): RegExp {
  const ident = name ? escapeRegex(name) : '[A-Za-z_$][\\w$]*';
  return new RegExp(`(?<![.\\w$@%])_(${ident})(?![\\w$])`, 'g');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace the contents of string literals with spaces (keeping the quotes and
 * all offsets) so that sigils inside strings are not mistaken for code.
 * Template-literal `${…}` interpolations stay visible, because Spindle
 * transforms the sigils inside them like any other code.
 */
function maskStrings(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      out += ch;
      i++;
      while (i < code.length && code[i] !== ch) {
        if (code[i] === '\\' && i + 1 < code.length) {
          out += '  ';
          i += 2;
        } else if (ch === '`' && code[i] === '$' && code[i + 1] === '{') {
          const end = interpolationEnd(code, i + 2);
          out += maskStrings(code.slice(i, end));
          i = end;
        } else {
          out += code[i] === '\n' ? '\n' : ' ';
          i++;
        }
      }
      if (i < code.length) {
        out += ch;
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Offset just past the `}` closing a `${` interpolation whose body starts at `from`. */
function interpolationEnd(code: string, from: number): number {
  let depth = 1;
  for (let i = from; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return i + 1;
  }
  return code.length;
}

/**
 * The `_name` target of `{computed _name = expr}`, located the same way
 * Spindle's parseComputedArgs() does: the first `=` at bracket depth 0 that
 * is not part of `==` or `!=`.
 */
function computedTemporaryTarget(rawArgs: string): TemporaryTarget[] {
  const lead = rawArgs.length - rawArgs.trimStart().length;
  const trimmed = rawArgs.trim();
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '=' && depth === 0) {
      if (trimmed[i + 1] === '=') {
        i++;
        continue;
      }
      if (i > 0 && trimmed[i - 1] === '!') continue;
      const target = trimmed.slice(0, i).trim();
      const m = /^_(\w+)$/.exec(target);
      return m ? [{ name: m[1], offset: lead }] : [];
    }
  }
  return [];
}

/**
 * Plain `_name = expr` assignments in a `{set}` expression. Accumulators are
 * skipped: compound operators (`_n += 1`), `++`/`--`, and assignments whose
 * right-hand side reads the same temporary (`_n = _n + @x`) all deliberately
 * carry a value from one iteration to the next.
 */
function setTemporaryTargets(rawArgs: string): TemporaryTarget[] {
  const code = maskStrings(rawArgs);
  const targets: TemporaryTarget[] = [];
  const assignRe = /(?<![.\w$@%])_([A-Za-z_$][\w$]*)\s*=(?![=>])/g;
  let m: RegExpExecArray | null;
  while ((m = assignRe.exec(code)) !== null) {
    const name = m[1];
    const rhs = code.slice(m.index + m[0].length, statementEnd(code, m.index + m[0].length));
    if (temporaryRefRegex(name).test(rhs)) continue;
    targets.push({ name, offset: m.index });
  }
  return targets;
}

/** Offset of the `;` or `,` that ends the expression starting at `from`. */
function statementEnd(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if ((ch === ';' || ch === ',') && depth <= 0) return i;
  }
  return code.length;
}

/**
 * Index of the innermost `{for}` whose body contains `macros[index]` in the
 * same passage, or -1. Returns -1 as well when a `{link}`/`{button}` sits
 * between the two: that body runs on click, not once per iteration.
 */
function enclosingLoop(
  macros: MacroNode[],
  index: number,
  uri: string,
  workspace: WorkspaceModel,
): number {
  for (let j = index - 1; j >= 0; j--) {
    const candidate = macros[j];
    if (!candidate.open || candidate.pair === -1 || candidate.pair < index) continue;
    const name = candidate.name.toLowerCase();
    if (DEFERRED_CONTAINERS.has(name)) return -1;
    if (name !== 'for') continue;
    const loopPassage = workspace.passages.getPassageAt(uri, candidate.range.start.line);
    const macroPassage = workspace.passages.getPassageAt(uri, macros[index].range.start.line);
    return loopPassage === macroPassage ? j : -1;
  }
  return -1;
}

function positionToOffset(pos: { line: number; character: number }, lineStarts: number[]): number {
  return (lineStarts[pos.line] ?? 0) + pos.character;
}

/**
 * A macro's raw arguments as written in the document, with their start
 * offset. `MacroNode.rawArgs` comes from text in which `{$var}`-style
 * interpolations were blanked out, which also blanks `${_x}` inside template
 * literals, so it cannot be used to analyse expressions.
 */
function sourceArgs(
  macro: MacroNode,
  text: string,
  lineStarts: number[],
): { args: string; start: number } {
  const end = positionToOffset(macro.range.end, lineStarts) - 1; // closing brace
  const start = end - (macro.rawArgs?.length ?? 0);
  return { args: text.slice(start, end), start };
}

/**
 * SP205: a `_temporary` assigned by `{computed}` or `{set}` inside a `{for}`
 * body and read elsewhere in that body.
 *
 * Spindle keeps temporaries in one store-wide map (`setTemporary`), while
 * `@locals` set inside a loop live in that iteration's own scope. Every
 * iteration therefore writes the same `_name`, and once the passage
 * re-renders all iterations read whichever value was written last.
 * Assignments whose temporary is not read inside the loop (a flag or value
 * handed out to code after the loop) are not reported.
 */
function validateLoopTemporaries(
  uri: string,
  text: string,
  macros: MacroNode[],
  workspace: WorkspaceModel,
  diagnostics: Diagnostic[],
): void {
  const lineStarts = buildLineStarts(text);

  for (let k = 0; k < macros.length; k++) {
    const macro = macros[k];
    if (!macro.open || !macro.rawArgs) continue;
    const name = macro.name.toLowerCase();
    if (name !== 'computed' && name !== 'set') continue;

    const { args, start: argsStart } = sourceArgs(macro, text, lineStarts);
    const targets = name === 'computed'
      ? computedTemporaryTarget(args)
      : setTemporaryTargets(args);
    if (targets.length === 0) continue;

    const loopIndex = enclosingLoop(macros, k, uri, workspace);
    if (loopIndex === -1) continue;
    const loop = macros[loopIndex];

    const bodyStart = positionToOffset(loop.range.end, lineStarts);
    const bodyEnd = positionToOffset(macros[loop.pair].range.start, lineStarts);
    const macroStart = positionToOffset(macro.range.start, lineStarts);
    const macroEnd = positionToOffset(macro.range.end, lineStarts);
    const body = text.slice(bodyStart, bodyEnd);

    for (const target of targets) {
      if (!isReadInBody(body, bodyStart, target.name, macroStart, macroEnd)) continue;

      const start = argsStart + target.offset;
      diagnostics.push(makeDiag(
        {
          start: offsetToPosition(start, lineStarts),
          end: offsetToPosition(start + 1 + target.name.length, lineStarts),
        },
        DiagnosticCode.TemporaryAssignedInLoop,
        `Temporary '_${target.name}' is assigned inside {${loop.name}} and read in the loop body. ` +
          'Temporaries are shared by every iteration, so all iterations end up seeing the value ' +
          `assigned by the last one. Use the iteration-local '@${target.name}' instead, ` +
          'or assign it once before the loop if the value does not depend on the iteration.',
      ));
    }
  }
}

/**
 * Whether `_name` is read somewhere in the loop body outside the assigning
 * macro. Occurrences that are themselves plain assignment targets
 * (`_name = …`) do not count as reads.
 */
function isReadInBody(
  body: string,
  bodyOffset: number,
  name: string,
  macroStart: number,
  macroEnd: number,
): boolean {
  const re = temporaryRefRegex(name);
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const offset = bodyOffset + m.index;
    if (offset >= macroStart && offset < macroEnd) continue;
    const after = body.slice(m.index + m[0].length);
    if (/^\s*=(?![=>])/.test(after)) continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// {include} of a [widget] passage (SP302)
// ---------------------------------------------------------------------------

/** Names Spindle's expression preamble binds; a bare one is not a passage name. */
const EXPRESSION_BUILTINS = new Set([
  'currentPassage', 'previousPassage', 'visited', 'hasVisited', 'hasVisitedAny',
  'hasVisitedAll', 'rendered', 'hasRendered', 'hasRenderedAny', 'hasRenderedAll',
  'random', 'randomInt',
]);

/**
 * Statically resolve the passage name an `{include}` renders, following
 * Spindle's Include macro: the arguments (minus an `inline` keyword) are
 * evaluated as an expression, and when evaluation throws the raw text with
 * surrounding quotes stripped is used instead. Returns null for dynamic
 * targets (variables, calls) that cannot be resolved without running the
 * story.
 */
export function resolveIncludeTarget(rawArgs: string): string | null {
  const expr = includeExpression(rawArgs);
  if (expr === '') return null;

  // A single string literal evaluates to its contents.
  const literal = /^(["'`])((?:\\.|(?!\1)[^\\])*)\1$/s.exec(expr);
  if (literal) {
    if (literal[1] === '`' && literal[2].includes('${')) return null;
    return literal[2].replace(/\\(.)/g, '$1');
  }

  // Anything that reads state or calls code is dynamic.
  if (/[$@%"'`(]/.test(expr) || temporaryRefRegex().test(expr)) return null;
  if (EXPRESSION_BUILTINS.has(expr)) return null;

  // A bare name such as `{include ActResist}` throws a ReferenceError (or a
  // SyntaxError for names with spaces), so Spindle falls back to the text.
  return expr;
}

/**
 * Names of the `{widget}` definitions in a passage's content, matched the way
 * Spindle's startup scan finds them (quoted or bare names).
 */
function widgetDefinitionNames(content: string): string[] {
  const names: string[] = [];
  const re = /\{widget\s+(["']?)([^\s"'}]+)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) names.push(m[2]);
  return names;
}

function passageContent(passage: Passage, workspace: WorkspaceModel): string {
  const text = workspace.documents.getText(passage.uri) ?? '';
  return text.split('\n').slice(passage.range.start.line + 1, passage.range.end.line + 1).join('\n');
}

/**
 * SP302: `{include}` whose target is a `widget`-tagged passage that defines
 * widgets. Spindle registers those `{widget}` definitions at startup; when
 * the passage is included, each `{widget}` macro renders nothing, so none of
 * the widgets' output appears. (A `widget`-tagged passage without
 * definitions renders its content like any other passage and is not
 * reported.)
 */
function validateWidgetIncludes(
  text: string,
  macros: MacroNode[],
  workspace: WorkspaceModel,
  diagnostics: Diagnostic[],
): void {
  let lineStarts: number[] | null = null;

  for (const macro of macros) {
    if (!macro.open || !macro.rawArgs || macro.name.toLowerCase() !== 'include') continue;

    lineStarts ??= buildLineStarts(text);
    const target = resolveIncludeTarget(sourceArgs(macro, text, lineStarts).args);
    if (target === null) continue;

    const passage = workspace.passages.getPassage(target);
    if (!passage?.tags?.includes('widget')) continue;

    const widgets = widgetDefinitionNames(passageContent(passage, workspace));
    if (widgets.length === 0) continue;

    const list = widgets.map(w => `{${w}}`).join(', ');
    diagnostics.push(makeDiag(
      macro.range,
      DiagnosticCode.IncludeWidgetPassage,
      `{include}: passage "${target}" is tagged [widget] and defines ${list}. ` +
        `Including it does not invoke ${widgets.length === 1 ? 'it' : 'them'}: {widget} definitions render nothing. ` +
        `Invoke the widget instead, e.g. {${widgets[0]}}.`,
    ));
  }
}

// ---------------------------------------------------------------------------
// Unused widgets (SP303)
// ---------------------------------------------------------------------------

/**
 * SP303: a widget defined in this document that no document in the workspace
 * invokes as `{name}`. Matching is case-insensitive, like Spindle's widget
 * lookup. Invocations from JavaScript-generated markup cannot be seen, hence
 * hint severity.
 */
function validateUnusedWidgets(
  uri: string,
  workspace: WorkspaceModel,
  diagnostics: Diagnostic[],
): void {
  for (const widget of workspace.widgets.getAllWidgets()) {
    if (widget.uri !== uri) continue;
    if (workspace.widgets.isInvoked(widget.name)) continue;
    diagnostics.push(makeDiag(
      widget.range,
      DiagnosticCode.UnusedWidget,
      `Widget "${widget.name}" is defined but never invoked in the workspace`,
    ));
  }
}

// ---------------------------------------------------------------------------
// Line-length validation (SP500)
// ---------------------------------------------------------------------------

function validateLineLength(
  text: string,
  passages: Passage[],
  maxLength: number,
  diagnostics: Diagnostic[],
): void {
  // Skip script/stylesheet passages — those have their own formatting rules
  const excludedLines = new Set<number>();
  for (const passage of passages.filter(isScriptOrStylesheetPassage)) {
    for (let i = passage.range.start.line; i <= passage.range.end.line; i++) {
      excludedLines.add(i);
    }
  }

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (excludedLines.has(i)) continue;
    const line = lines[i];
    // Skip passage headers
    if (/^::\s+/.test(line)) continue;
    // Skip HTML-heavy lines (tags with attributes)
    if (/^\s*<[a-zA-Z]/.test(line)) continue;

    if (line.length > maxLength) {
      diagnostics.push(makeDiag(
        {
          start: { line: i, character: maxLength },
          end: { line: i, character: line.length },
        },
        DiagnosticCode.LineTooLong,
        `Line exceeds ${maxLength} characters (${line.length})`,
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
    // Per-code enable/disable map, e.g. { SP100: false }
    const isEnabled = (d: Diagnostic) => ctx.config.diagnostics?.[d.code] !== false;

    const publishFor = (uri: string) => {
      const diags = computeDiagnostics(uri, ctx.workspace);
      ctx.connection.sendDiagnostics({
        uri,
        diagnostics: diags.filter(isEnabled).map(d => toLspDiagnostic(d)),
      });
    };

    ctx.workspace.on('modelReady', () => {
      for (const uri of ctx.workspace.documents.getUris()) {
        if (isMacroSource(uri)) continue;
        publishFor(uri);
      }
    });
    ctx.workspace.on('documentChanged', publishFor);
    // A document that left the store won't be republished — clear its
    // diagnostics so the editor drops stale problems.
    ctx.workspace.on('documentClosed', (uri: string) => {
      ctx.connection.sendDiagnostics({ uri, diagnostics: [] });
    });
  },
};
