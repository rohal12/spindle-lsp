import type { Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import {
  findPassageReferences,
  findVariableReferences,
  findTransientReferences,
  findWidgetReferences,
} from './references.js';

// ---------------------------------------------------------------------------
// Core rename functions (no LSP dependency)
// ---------------------------------------------------------------------------

export interface PrepareRenameResult {
  range: Range;
  placeholder: string;
}

export interface RenameEdit {
  range: Range;
  newText: string;
}

/**
 * Determine if the symbol at the cursor is renameable, and return its range + placeholder.
 */
export function prepareRename(
  uri: string,
  position: Position,
  workspace: WorkspaceModel,
): PrepareRenameResult | null {
  const symbol = resolveSymbolAtCursor(uri, position, workspace);
  if (!symbol) return null;
  return { range: symbol.range, placeholder: symbol.name };
}

/**
 * Compute all text edits for a rename operation.
 * Returns a map of URI -> list of edits.
 */
export function computeRename(
  uri: string,
  position: Position,
  newName: string,
  workspace: WorkspaceModel,
): Map<string, RenameEdit[]> {
  const symbol = resolveSymbolAtCursor(uri, position, workspace);
  if (!symbol) return new Map();

  const edits = new Map<string, RenameEdit[]>();

  function addEdit(editUri: string, range: Range, text: string) {
    const existing = edits.get(editUri) ?? [];
    existing.push({ range, newText: text });
    edits.set(editUri, existing);
  }

  switch (symbol.kind) {
    case 'passage': {
      const refs = findPassageReferences(symbol.name, workspace, true);
      for (const ref of refs) {
        addEdit(ref.uri, ref.range, newName);
      }
      break;
    }

    case 'variable': {
      const bareName = newName.startsWith('$') ? newName.slice(1) :
                       newName.startsWith('%') ? newName.slice(1) : newName;
      const isTransient = workspace.variables.getDeclaredTransient().has(symbol.name);
      const refs = isTransient
        ? findTransientReferences(symbol.name, workspace, true)
        : findVariableReferences(symbol.name, workspace, true);
      for (const ref of refs) {
        addEdit(ref.uri, ref.range, bareName);
      }
      break;
    }

    case 'widget': {
      // Rename invocations
      const invocationRefs = findWidgetReferences(symbol.name, workspace, false);
      for (const ref of invocationRefs) {
        addEdit(ref.uri, ref.range, newName);
      }

      // Rename definition
      const widget = workspace.widgets.getWidget(symbol.name);
      if (widget) {
        // The widget definition is {widget "name" ...}
        // We need to find and replace just the name inside the quotes
        const docText = workspace.documents.getText(widget.uri);
        if (docText) {
          const lines = docText.split('\n');
          const defLine = lines[widget.range.start.line];
          if (defLine) {
            const defSlice = defLine.slice(widget.range.start.character);
            const nameMatch = /\{widget\s+"([^"]+)"/.exec(defSlice);
            if (nameMatch) {
              const nameOffsetInSlice = defSlice.indexOf(nameMatch[1]);
              const nameStart = widget.range.start.character + nameOffsetInSlice;
              addEdit(widget.uri, {
                start: { line: widget.range.start.line, character: nameStart },
                end: { line: widget.range.start.line, character: nameStart + symbol.name.length },
              }, newName);
            }
          }
        }
      }
      break;
    }
  }

  return edits;
}

// ---------------------------------------------------------------------------
// Symbol resolution
// ---------------------------------------------------------------------------

interface SymbolInfo {
  kind: 'passage' | 'variable' | 'widget';
  name: string;
  range: Range;
}

function resolveSymbolAtCursor(
  uri: string,
  position: Position,
  workspace: WorkspaceModel,
): SymbolInfo | null {
  const text = workspace.documents.getText(uri);
  if (text === undefined) return null;

  const lines = text.split('\n');
  if (position.line >= lines.length) return null;
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
        return {
          kind: 'passage',
          name: passageName,
          range: {
            start: { line: position.line, character: nameStart },
            end: { line: position.line, character: nameEnd },
          },
        };
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
        return {
          kind: 'variable',
          name: match[1],
          range: {
            start: { line: position.line, character: start },
            end: { line: position.line, character: end },
          },
        };
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
        return {
          kind: 'variable',
          name: match[1],
          range: {
            start: { line: position.line, character: start },
            end: { line: position.line, character: end },
          },
        };
      }
    }
  }

  // --- Widget definition: {widget "name" ...} ---
  {
    const widgetDefRegex = /\{widget\s+"([^"]+)"/gi;
    let match: RegExpExecArray | null;
    while ((match = widgetDefRegex.exec(line)) !== null) {
      const name = match[1];
      const nameStart = match.index + match[0].indexOf(name);
      const nameEnd = nameStart + name.length;
      if (position.character >= nameStart && position.character <= nameEnd) {
        return {
          kind: 'widget',
          name,
          range: {
            start: { line: position.line, character: nameStart },
            end: { line: position.line, character: nameEnd },
          },
        };
      }
    }
  }

  // --- Widget invocation: {widgetName ...} ---
  {
    const re = /\{([A-Za-z_$][\w$]*)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      const name = match[1];
      const nameStart = match.index + 1;
      const nameEnd = nameStart + name.length;
      if (position.character >= nameStart && position.character <= nameEnd) {
        if (!workspace.macros.getMacro(name) && workspace.widgets.getWidget(name)) {
          return {
            kind: 'widget',
            name,
            range: {
              start: { line: position.line, character: nameStart },
              end: { line: position.line, character: nameEnd },
            },
          };
        }
      }
    }
  }

  return null;
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

export const renamePlugin: SpindlePlugin = {
  id: 'rename',
  capabilities: {
    renameProvider: {
      prepareProvider: true,
    },
  },
  initialize(ctx: PluginContext) {
    ctx.connection.onPrepareRename((params) => {
      const result = prepareRename(
        params.textDocument.uri,
        { line: params.position.line, character: params.position.character },
        ctx.workspace,
      );
      if (!result) return null;
      return {
        range: toLspRange(result.range),
        placeholder: result.placeholder,
      };
    });

    ctx.connection.onRenameRequest((params) => {
      const editsMap = computeRename(
        params.textDocument.uri,
        { line: params.position.line, character: params.position.character },
        params.newName,
        ctx.workspace,
      );

      const changes: Record<string, import('vscode-languageserver').TextEdit[]> = {};
      for (const [editUri, edits] of editsMap) {
        changes[editUri] = edits.map(e => ({
          range: toLspRange(e.range),
          newText: e.newText,
        }));
      }

      return { changes };
    });
  },
};
