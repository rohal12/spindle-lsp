import type { Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { documentMacroHeads, macroHeadAt } from '../core/markup/macro-heads.js';
import { documentRefsNamed, passageRefAt, type PassageRef } from '../core/markup/passage-refs.js';
import { parsePassageHeader } from '../core/parsing/passage-parser.js';

// ---------------------------------------------------------------------------
// Core references function (no LSP dependency)
// ---------------------------------------------------------------------------

export interface ReferenceLocation {
  uri: string;
  range: Range;
}

/**
 * Find all references to the symbol at the given position.
 *
 * Supports:
 *  - Passage header -> all [[links]] + macro refs to that passage
 *  - Variable -> all usages across workspace
 *  - Widget -> all invocations
 */
export function findReferences(
  uri: string,
  position: Position,
  workspace: WorkspaceModel,
  includeDeclaration: boolean,
): ReferenceLocation[] {
  const text = workspace.documents.getText(uri);
  if (text === undefined || !workspace.hasPassages(uri)) return [];

  const lines = text.split('\n');
  if (position.line >= lines.length) return [];
  const line = lines[position.line];

  // --- Passage header ---
  const header = parsePassageHeader(line, position.line);
  if (header) {
    const { start, end } = header.nameRange;
    if (position.character >= start.character && position.character <= end.character) {
      return findPassageReferences(header.name, workspace, includeDeclaration);
    }
  }

  // --- $variable / %transient ---
  const variable = variableAt(uri, position, workspace);
  if (variable) {
    return variable.sigil === '%'
      ? findTransientReferences(variable.name, workspace, includeDeclaration)
      : findVariableReferences(variable.name, workspace, includeDeclaration);
  }

  // --- Widget ---
  const declaration = workspace.widgets.definitionAt(uri, position);
  if (declaration) return findWidgetReferences(declaration.name, workspace, includeDeclaration);

  const doc = workspace.markup.get(uri);
  const head = doc && macroHeadAt(doc, position);
  if (head) {
    const widget = workspace.widgets.getWidget(head.name);
    if (!workspace.macros.getMacro(head.name) && widget && (!head.closing || widget.block)) {
      return findWidgetReferences(head.name, workspace, includeDeclaration);
    }
  }

  // --- Passage name written out: [[link]] or a quoted macro argument ---
  const passageRef = doc && passageRefAt(doc, position);
  if (passageRef) {
    return findPassageReferences(passageRef.name, workspace, includeDeclaration);
  }

  return [];
}

// ---------------------------------------------------------------------------
// The variable under the cursor
// ---------------------------------------------------------------------------

export interface VariableAtCursor {
  sigil: '$' | '%';
  /** Base name, without the sigil or any property path. */
  name: string;
  /** The tracker's reference (or declaration) range: sigil, name and property path. */
  range: Range;
}

/** The tracker owns executable source ranges, including escaped spellings. */
export function variableAt(uri: string, position: Position, workspace: WorkspaceModel): VariableAtCursor | null {
  return workspace.variables.referenceAt(uri, position);
}

// ---------------------------------------------------------------------------
// Reference finders
// ---------------------------------------------------------------------------

/**
 * Find all references to a passage across the workspace.
 */
export function findPassageReferences(
  passageName: string,
  workspace: WorkspaceModel,
  includeDeclaration: boolean,
): ReferenceLocation[] {
  const locations: ReferenceLocation[] = [];

  // Include declaration (the name in the passage header)
  if (includeDeclaration) {
    for (const passage of workspace.passages.getPassages(passageName)) {
      locations.push({
        uri: passage.uri,
        range: passage.nameRange,
      });
    }
  }

  for (const { uri, ref } of findPassageRefs(passageName, workspace)) {
    locations.push({ uri, range: ref.range });
  }

  return locations;
}

/**
 * The passage names written out that name `passageName`, with the spelling
 * of each (so that an edit can re-encode a new name for it): `[[links]]`,
 * quoted `goto`/`include`/`link`/`watch` arguments and `{dialog}` bodies,
 * labels and attribute values that hold markup included. Script/stylesheet
 * bodies, strings of other macros and expressions (a bare word, a template
 * literal) are not references.
 */
export function findPassageRefs(
  passageName: string,
  workspace: WorkspaceModel,
): Array<{ uri: string; ref: PassageRef }> {
  const found: Array<{ uri: string; ref: PassageRef }> = [];
  for (const docUri of workspace.documents.getUris()) {
    const doc = workspace.markup.get(docUri);
    if (!doc) continue;
    for (const ref of documentRefsNamed(doc, passageName)) found.push({ uri: docUri, ref });
  }
  return found;
}

/**
 * Find all references to a variable across the workspace.
 */
export function findVariableReferences(
  varName: string,
  workspace: WorkspaceModel,
  includeDeclaration: boolean,
): ReferenceLocation[] {
  const locations: ReferenceLocation[] = [];

  if (includeDeclaration) {
    locations.push(...workspace.variables.getDeclarations(varName, '$'));
  }

  // Get all usages from the variable tracker
  const usages = workspace.variables.getUsages(varName);
  for (const u of usages) {
    locations.push({ uri: u.uri, range: u.range });
  }

  return locations;
}

/**
 * Find all references to a transient variable across the workspace.
 */
export function findTransientReferences(
  varName: string,
  workspace: WorkspaceModel,
  includeDeclaration: boolean,
): ReferenceLocation[] {
  const results: ReferenceLocation[] = [];

  if (includeDeclaration) {
    results.push(...workspace.variables.getDeclarations(varName, '%'));
  }

  const usages = workspace.variables.getTransientUsages(varName);
  for (const u of usages) {
    results.push({ uri: u.uri, range: u.range });
  }

  return results;
}

/**
 * Find all references to a widget across the workspace.
 * Closing tags participate in navigation/rename; usage counts omit them.
 */
export function findWidgetReferences(
  widgetName: string,
  workspace: WorkspaceModel,
  includeDeclaration: boolean,
  includeClosingTags = true,
): ReferenceLocation[] {
  const locations: ReferenceLocation[] = [];
  const widget = workspace.widgets.getWidget(widgetName);

  // Include declaration
  if (includeDeclaration && widget) {
    locations.push({ uri: widget.uri, range: widget.range });
  }

  // Macros take precedence over widgets, including when the request starts
  // at a shadowed widget's declaration. Only that declaration belongs to it.
  if (workspace.macros.getMacro(widgetName)) return locations;

  // Every call of the widget the runtime runs (case-insensitive, like Spindle):
  // the macros of the paired markup, those in labels and attribute values
  // included, and its {/widgetName} closing tags when the widget is a block widget
  const lowerName = widgetName.toLowerCase();
  const isBlock = widget?.block ?? false;

  for (const docUri of workspace.documents.getUris()) {
    const doc = workspace.markup.get(docUri);
    if (!doc) continue;
    for (const head of documentMacroHeads(doc)) {
      if (head.closing && (!isBlock || !includeClosingTags)) continue;
      if (head.name.toLowerCase() === lowerName) {
        locations.push({ uri: docUri, range: head.range });
      }
    }
  }

  return locations;
}

// ---------------------------------------------------------------------------
// Plugin wrapper (LSP integration)
// ---------------------------------------------------------------------------

function toLspRange(r: Range): import('vscode-languageserver').Range {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}

export const referencesPlugin: SpindlePlugin = {
  id: 'references',
  capabilities: {
    referencesProvider: true,
  },
  initialize(ctx: PluginContext) {
    ctx.connection.onReferences((params) => {
      const refs = findReferences(
        params.textDocument.uri,
        { line: params.position.line, character: params.position.character },
        ctx.workspace,
        params.context.includeDeclaration,
      );
      return refs.map(r => ({
        uri: r.uri,
        range: toLspRange(r.range),
      }));
    });
  },
};
