import type { Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { parseLinks } from '../core/parsing/link-parser.js';
import { parseMacros } from '../core/parsing/macro-parser.js';

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
  const passageHeaderRegex = /^::\s*(\S.*?)(?:\s*\[|\s*\{|\s*$)/;
  if (line.trimStart().startsWith('::')) {
    const headerMatch = passageHeaderRegex.exec(line);
    if (headerMatch) {
      const passageName = headerMatch[1].trim();
      const nameStart = line.indexOf(passageName);
      const nameEnd = nameStart + passageName.length;
      if (position.character >= nameStart && position.character <= nameEnd) {
        return findPassageReferences(passageName, workspace, includeDeclaration);
      }
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

  // --- Widget ---
  {
    const widgetRegex = /\{([A-Za-z_$][\w$]*)/g;
    let match: RegExpExecArray | null;
    while ((match = widgetRegex.exec(line)) !== null) {
      const name = match[1];
      const nameStart = match.index + 1;
      const nameEnd = nameStart + name.length;
      if (position.character >= nameStart && position.character <= nameEnd) {
        if (!workspace.macros.getMacro(name) && workspace.widgets.getWidget(name)) {
          return findWidgetReferences(name, workspace, includeDeclaration);
        }
      }
    }
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

  // Include declaration (passage header)
  if (includeDeclaration) {
    const passage = workspace.passages.getPassage(passageName);
    if (passage) {
      locations.push({
        uri: passage.uri,
        range: passage.headerEnd,
      });
    }
  }

  // Scan all documents for passage references
  const gotoRegex = /\{(?:goto|include)\s+"([^"]+)"\s*\}/gi;
  const linkMacroRegex = /\{(?:link|button)\s+"[^"]*"\s+"([^"]+)"\s*\}/gi;

  for (const docUri of workspace.documents.getUris()) {
    const docText = workspace.documents.getText(docUri);
    if (!docText) continue;

    // Find [[passage]] links
    const links = parseLinks(docText);
    for (const link of links) {
      if (link.name === passageName) {
        locations.push({ uri: docUri, range: link.range });
      }
    }

    // Find {goto "passage"} and {include "passage"}
    const lines = docText.split('\n');
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];

      for (const regex of [gotoRegex, linkMacroRegex]) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line)) !== null) {
          if (match[1] === passageName) {
            const nameStart = match.index + match[0].indexOf(match[1]);
            locations.push({
              uri: docUri,
              range: {
                start: { line: lineNum, character: nameStart },
                end: { line: lineNum, character: nameStart + match[1].length },
              },
            });
          }
        }
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
 * Find all references to a widget across the workspace.
 */
export function findWidgetReferences(
  widgetName: string,
  workspace: WorkspaceModel,
  includeDeclaration: boolean,
): ReferenceLocation[] {
  const locations: ReferenceLocation[] = [];

  // Include declaration
  if (includeDeclaration) {
    const widget = workspace.widgets.getWidget(widgetName);
    if (widget) {
      locations.push({ uri: widget.uri, range: widget.range });
    }
  }

  // Scan all documents for {widgetName ...} invocations
  const widgetInvocationRegex = /\{([A-Za-z_$][\w$]*)\b/g;

  for (const docUri of workspace.documents.getUris()) {
    const docText = workspace.documents.getText(docUri);
    if (!docText) continue;

    const lines = docText.split('\n');
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];

      // Skip widget definition lines
      if (/\{widget\s+"/i.test(line)) continue;

      widgetInvocationRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = widgetInvocationRegex.exec(line)) !== null) {
        if (match[1] === widgetName) {
          const nameStart = match.index + 1; // skip '{'
          locations.push({
            uri: docUri,
            range: {
              start: { line: lineNum, character: nameStart },
              end: { line: lineNum, character: nameStart + widgetName.length },
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
