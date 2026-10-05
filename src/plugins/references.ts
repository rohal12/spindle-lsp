import type { Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { findPassageRefAt, parseDocumentPassageRefs, type PassageRef } from '../core/parsing/link-parser.js';
import { parseMacros, macroHeadNames, macroHeadNameAt } from '../core/parsing/macro-parser.js';
import { parsePassageHeader } from '../core/parsing/passage-parser.js';
import { isMacroSource } from '../core/workspace/macro-sources.js';

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
  if (text === undefined) return [];

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

  // --- $variable ---
  {
    const varRegex = /\$([\w$]+)/g;
    let match: RegExpExecArray | null;
    while ((match = varRegex.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        const varName = match[1];
        return findVariableReferences(varName, workspace, includeDeclaration);
      }
    }
  }

  // --- %transient ---
  {
    const transRegex = /(?<!\w)%([\w$]+)/g;
    let match: RegExpExecArray | null;
    while ((match = transRegex.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        const varName = match[1];
        if (!isTransientAt(varName, uri, position.line, start, workspace)) break;
        return findTransientReferences(varName, workspace, includeDeclaration);
      }
    }
  }

  // --- Widget ---
  {
    const head = macroHeadNameAt(text, position);
    if (head) {
      const widget = workspace.widgets.getWidget(head.name);
      if (!workspace.macros.getMacro(head.name) && widget && (!head.closing || widget.block)) {
        return findWidgetReferences(head.name, workspace, includeDeclaration);
      }
    }
  }

  // --- Passage reference in [[link]] or macro arguments ---
  const passageRef = findPassageRefAt(text, position, workspace.passages.getPassagesInDocument(uri));
  if (passageRef) {
    return findPassageReferences(passageRef.name, workspace, includeDeclaration);
  }

  // --- Passage name in link (also check passage names) ---
  {
    const allPassages = workspace.passages.getAllPassages();
    const passageNames = new Set(allPassages.map(p => p.name));
    // Try to extract a word at cursor and see if it's a passage name
    const wordRegex = /[A-Za-z_$][\w$\s]*/g;
    let match: RegExpExecArray | null;
    while ((match = wordRegex.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        const word = match[0].trim();
        if (passageNames.has(word)) {
          return findPassageReferences(word, workspace, includeDeclaration);
        }
      }
    }
  }

  return [];
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
    const passage = workspace.passages.getPassage(passageName);
    if (passage) {
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
 * The executable references (`[[links]]` and literal macro targets) to a
 * passage, with the spelling of each target, so that an edit can re-encode a
 * new name for it. Script/stylesheet bodies, macro-argument strings and HTML
 * attribute values are not references.
 */
export function findPassageRefs(
  passageName: string,
  workspace: WorkspaceModel,
): Array<{ uri: string; ref: PassageRef }> {
  const found: Array<{ uri: string; ref: PassageRef }> = [];
  for (const docUri of workspace.documents.getUris()) {
    if (isMacroSource(docUri)) continue;
    const docText = workspace.documents.getText(docUri);
    if (!docText) continue;

    const passages = workspace.passages.getPassagesInDocument(docUri);
    for (const ref of parseDocumentPassageRefs(docText, passages)) {
      if (ref.name === passageName) found.push({ uri: docUri, ref });
    }
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

  // Include declaration from StoryVariables
  if (includeDeclaration) {
    const decl = workspace.variables.getDeclared().get(varName);
    if (decl?.declarationRange && decl.declarationUri) {
      locations.push({
        uri: decl.declarationUri,
        range: decl.declarationRange,
      });
    }
  }

  // Get all usages from the variable tracker
  const usages = workspace.variables.getUsages(varName);
  for (const u of usages) {
    locations.push({ uri: u.uri, range: u.range });
  }

  return locations;
}

/**
 * Whether the `%name` at line/character is a transient reference. A name
 * starting with a digit is one only where the variable tracker records it
 * (in code, where Spindle evaluates it) or at its declaration: `%20` in
 * prose or an HTML attribute is URL encoding.
 */
export function isTransientAt(
  name: string,
  uri: string,
  line: number,
  character: number,
  workspace: WorkspaceModel,
): boolean {
  if (!/^\d/.test(name)) return true;
  const at = (u: { uri?: string; range?: Range }) =>
    u.uri === uri && u.range?.start.line === line && u.range.start.character === character;
  const decl = workspace.variables.getDeclaredTransient().get(name);
  if (decl && at({ uri: decl.declarationUri, range: decl.declarationRange })) return true;
  return workspace.variables.getTransientUsages(name).some(at);
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
    const decl = workspace.variables.getDeclaredTransient().get(varName);
    if (decl?.declarationUri && decl.declarationRange) {
      results.push({ uri: decl.declarationUri, range: decl.declarationRange });
    }
  }

  const usages = workspace.variables.getTransientUsages(varName);
  for (const u of usages) {
    results.push({ uri: u.uri, range: u.range });
  }

  return results;
}

/**
 * Find all references to a widget across the workspace.
 */
export function findWidgetReferences(
  widgetName: string,
  workspace: WorkspaceModel,
  includeDeclaration: boolean,
): ReferenceLocation[] {
  const locations: ReferenceLocation[] = [];
  const widget = workspace.widgets.getWidget(widgetName);

  // Include declaration
  if (includeDeclaration && widget) {
    locations.push({ uri: widget.uri, range: widget.range });
  }

  // Scan all documents for widget calls using the shared macro grammar
  // (case-insensitive, like Spindle), plus {/widgetName} closing tags when the
  // widget is a block widget.
  const lowerName = widgetName.toLowerCase();
  const isBlock = widget?.block ?? false;

  for (const docUri of workspace.documents.getUris()) {
    if (isMacroSource(docUri)) continue;
    const docText = workspace.documents.getText(docUri);
    if (!docText) continue;

    for (const head of macroHeadNames(docText)) {
      if (head.closing && !isBlock) continue;
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
