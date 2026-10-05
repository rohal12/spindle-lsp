import type { Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { findPassageRefAt, parseLinks, parseMacroPassageRefs } from '../core/parsing/link-parser.js';
import { parseMacros } from '../core/parsing/macro-parser.js';
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
    const varRegex = /\$([A-Za-z_$][\w$]*)/g;
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
    const transRegex = /(?<!\w)%([A-Za-z_$][\w$]*)/g;
    let match: RegExpExecArray | null;
    while ((match = transRegex.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        const varName = match[1];
        return findTransientReferences(varName, workspace, includeDeclaration);
      }
    }
  }

  // --- Widget ---
  {
    const widgetRegex = /\{\/?([A-Za-z_$][\w$]*)/g;
    let match: RegExpExecArray | null;
    while ((match = widgetRegex.exec(line)) !== null) {
      const name = match[1];
      const nameStart = match.index + match[0].length - name.length;
      const nameEnd = nameStart + name.length;
      if (position.character >= nameStart && position.character <= nameEnd) {
        const widget = workspace.widgets.getWidget(name);
        const isClosing = match[0][1] === '/';
        if (!workspace.macros.getMacro(name) && widget && (!isClosing || widget.block)) {
          return findWidgetReferences(name, workspace, includeDeclaration);
        }
      }
    }
  }

  // --- Passage reference in [[link]] or macro arguments ---
  const passageRef = findPassageRefAt(text, position);
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

  // Scan all documents for [[links]] and macro references
  // ({goto}, {include}, {link "label" "passage"})
  for (const docUri of workspace.documents.getUris()) {
    if (isMacroSource(docUri)) continue;
    const docText = workspace.documents.getText(docUri);
    if (!docText) continue;

    for (const ref of [...parseLinks(docText), ...parseMacroPassageRefs(docText)]) {
      if (ref.name === passageName) {
        locations.push({ uri: docUri, range: ref.range });
      }
    }
  }

  return locations;
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

  // Scan all documents for {widgetName ...} invocations (case-insensitive, like Spindle),
  // plus {/widgetName} closing tags when the widget is a block widget.
  const widgetInvocationRegex = /\{(\/)?([A-Za-z_$][\w$]*)\b/g;
  const lowerName = widgetName.toLowerCase();
  const isBlock = widget?.block ?? false;

  for (const docUri of workspace.documents.getUris()) {
    if (isMacroSource(docUri)) continue;
    const docText = workspace.documents.getText(docUri);
    if (!docText) continue;

    const lines = docText.split('\n');
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];

      widgetInvocationRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = widgetInvocationRegex.exec(line)) !== null) {
        if (match[1] && !isBlock) continue;
        if (match[2].toLowerCase() === lowerName) {
          const nameStart = match.index + 1 + (match[1] ? 1 : 0); // skip '{' or '{/'
          locations.push({
            uri: docUri,
            range: {
              start: { line: lineNum, character: nameStart },
              end: { line: lineNum, character: nameStart + match[2].length },
            },
          });
        }
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
