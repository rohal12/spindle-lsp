import type { CompletionItem } from 'vscode-languageserver';
import type { Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { parseMacros, pairMacros, buildLineStarts } from '../core/parsing/macro-parser.js';
import { inAttributeValue } from '../core/parsing/html-scanner.js';

// ---------------------------------------------------------------------------
// Core completion function (no LSP dependency)
// ---------------------------------------------------------------------------

/**
 * Compute completion items for a given position within a document.
 *
 * Contexts:
 *  - After `{/`  -> closing macro names (open block macros above cursor)
 *  - After `{`   -> macro names + widget names
 *  - After `$`   -> story variable names
 *  - After `_`   -> temp variable names from current document
 *  - After `@`   -> local variable names from current document
 *  - After `%`   -> transient variable names
 *  - After `$var.` -> declared object fields
 *  - After `%var.` -> declared transient object fields
 *  - After `[[`  -> passage names
 *
 * No macro names or closing tags are offered inside an HTML attribute value,
 * where Spindle outputs macros as text (SP103).
 */
export function getCompletions(
  uri: string,
  position: Position,
  triggerChar: string | undefined,
  workspace: WorkspaceModel,
): CompletionItem[] {
  const text = workspace.documents.getText(uri);
  if (text === undefined) return [];

  const lines = text.split('\n');
  if (position.line >= lines.length) return [];
  const lineText = lines[position.line].substring(0, position.character);

  // Spindle outputs macros inside an attribute value as text (SP103), so
  // offer none there. The character before the cursor is the one typed.
  const inAttribute = () =>
    inAttributeValue(text, (buildLineStarts(text)[position.line] ?? 0) + position.character - 1);

  // --- Context: closing macro `{/` ---
  const closing = /\{\/[A-Za-z\w-]*$/.exec(lineText);
  if (closing) {
    if (inAttribute()) return [];
    // The edit replaces the typed `{/name` prefix (and an already-present
    // `name}` tail) so accepting never duplicates braces or slashes.
    const rest = lines[position.line].substring(position.character);
    const tail = /^[\w-]*\}?/.exec(rest)![0].length;
    const range = {
      start: { line: position.line, character: closing.index },
      end: { line: position.line, character: position.character + tail },
    };
    return getClosingMacroCompletions(uri, text, position, workspace, range);
  }

  // --- Context: dot-path field `%var.` ---
  const transientDotPathMatch = /%([\w$]+)\.([A-Za-z_$][\w$]*)?$/.exec(lineText);
  if (transientDotPathMatch) {
    return getTransientDotPathCompletions(transientDotPathMatch[1], workspace);
  }

  // --- Context: dot-path field `$var.` ---
  const dotPathMatch = /\$([\w$]+)\.([A-Za-z_$][\w$]*)?$/.exec(lineText);
  if (dotPathMatch) {
    return getDotPathCompletions(dotPathMatch[1], workspace);
  }

  // --- Context: story variable `$` ---
  if (/\$[A-Za-z_$]?[\w$]*$/.test(lineText) && !/\$[A-Za-z_$][\w$]*\./.test(lineText)) {
    return getStoryVariableCompletions(workspace);
  }

  // --- Context: temporary variable `_` ---
  if (/_[A-Za-z_$]?[\w$]*$/.test(lineText)) {
    return getTempVariableCompletions(text);
  }

  // --- Context: local variable `@` ---
  if (/@[A-Za-z_$]?[\w$]*$/.test(lineText)) {
    return getLocalVariableCompletions(text);
  }

  // --- Context: transient variable `%` ---
  if (/%[A-Za-z_$]?[\w$]*$/.test(lineText) && !/%[A-Za-z_$][\w$]*\./.test(lineText)) {
    return getTransientVariableCompletions(workspace);
  }

  // --- Context: passage link `[[` ---
  if (/\[\[[^\]]*$/.test(lineText)) {
    return getPassageNameCompletions(workspace);
  }

  // --- Context: macro invocation `{` or `{partial` ---
  if (/(?:^|[^\\])\{[A-Za-z\w-]*$/.test(lineText)) {
    return inAttribute() ? [] : getMacroCompletions(workspace);
  }

  return [];
}

// ---------------------------------------------------------------------------
// Sub-functions
// ---------------------------------------------------------------------------

function getClosingMacroCompletions(
  uri: string,
  text: string,
  position: Position,
  workspace: WorkspaceModel,
  range: Range,
): CompletionItem[] {
  const passages = workspace.passages.getPassagesInDocument(uri);
  const macros = parseMacros(text);
  pairMacros(
    macros,
    (name) => workspace.isContainer(name),
    passages.map(p => p.range.start.line),
  );

  // Only containers opened in the cursor's passage can be closed here
  const passageStart = workspace.passages.getPassageAt(uri, position.line)?.range.start.line ?? 0;

  const openStack: string[] = [];
  for (const macro of macros) {
    if (macro.range.start.line < passageStart) continue;
    if (macro.range.start.line > position.line ||
      (macro.range.start.line === position.line && macro.range.start.character >= position.character)) {
      break;
    }
    if (!macro.open) continue;
    if (!workspace.isContainer(macro.name)) continue;

    if (macro.pair === -1) {
      openStack.push(macro.name);
    } else {
      const pairMacro = macros[macro.pair];
      if (pairMacro && (pairMacro.range.start.line > position.line ||
        (pairMacro.range.start.line === position.line && pairMacro.range.start.character > position.character))) {
        openStack.push(macro.name);
      }
    }
  }

  if (openStack.length === 0) return [];

  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (let i = openStack.length - 1; i >= 0; i--) {
    const name = openStack[i];
    if (!seen.has(name)) {
      seen.add(name);
      suggestions.push(name);
    }
  }

  return suggestions.map((name, idx) => ({
    label: `{/${name}}`,
    kind: 14, // CompletionItemKind.Keyword
    detail: `Close {${name}}`,
    sortText: String(idx).padStart(3, '0'),
    filterText: `{/${name}}`,
    insertText: `{/${name}}`,
    textEdit: { range, newText: `{/${name}}` },
  }));
}

function getMacroCompletions(workspace: WorkspaceModel): CompletionItem[] {
  const items: CompletionItem[] = [];

  for (const macro of workspace.macros.getAllMacros()) {
    items.push({
      label: macro.name,
      kind: 3, // CompletionItemKind.Function
      detail: macro.block ? `(container macro) ${macro.name}` : `(macro) ${macro.name}`,
      documentation: macro.description ?? undefined,
    });
  }

  for (const widget of workspace.widgets.getAllWidgets()) {
    items.push({
      label: widget.name,
      kind: 3, // CompletionItemKind.Function
      detail: `(widget) ${widget.name}`,
      documentation: widget.params.length > 0
        ? `Parameters: ${widget.params.join(', ')}`
        : undefined,
    });
  }

  return items;
}

function getStoryVariableCompletions(workspace: WorkspaceModel): CompletionItem[] {
  const declared = workspace.variables.getDeclared();
  if (declared.size === 0) return [];

  const items: CompletionItem[] = [];
  for (const [name, decl] of declared) {
    items.push({
      label: `$${name}`,
      kind: 6, // CompletionItemKind.Variable
      detail: 'story variable',
      insertText: name,
      documentation: decl.fields && decl.fields.length > 0
        ? `Fields: ${decl.fields.join(', ')}`
        : undefined,
    });
  }
  return items;
}

function getTempVariableCompletions(text: string): CompletionItem[] {
  const tempVarRegex = /_([A-Za-z_$][\w$]*)/g;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = tempVarRegex.exec(text)) !== null) {
    names.add(m[1]);
  }
  if (names.size === 0) return [];

  return Array.from(names).map(name => ({
    label: `_${name}`,
    kind: 6, // CompletionItemKind.Variable
    detail: 'temporary variable',
    insertText: name,
  }));
}

function getLocalVariableCompletions(text: string): CompletionItem[] {
  const atVarRegex = /@([A-Za-z_$][\w$]*)/g;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = atVarRegex.exec(text)) !== null) {
    names.add(m[1]);
  }
  if (names.size === 0) return [];

  return Array.from(names).map(name => ({
    label: `@${name}`,
    kind: 6, // CompletionItemKind.Variable
    detail: 'local/parameter variable',
    insertText: name,
  }));
}

function getDotPathCompletions(varName: string, workspace: WorkspaceModel): CompletionItem[] {
  const declared = workspace.variables.getDeclared();
  const decl = declared.get(varName);
  if (!decl || !decl.fields || decl.fields.length === 0) return [];

  return decl.fields.map(field => ({
    label: field,
    kind: 5, // CompletionItemKind.Field
    detail: `field of $${varName}`,
  }));
}

function getTransientVariableCompletions(workspace: WorkspaceModel): CompletionItem[] {
  const declared = workspace.variables.getDeclaredTransient();
  if (declared.size === 0) return [];

  const items: CompletionItem[] = [];
  for (const [name, decl] of declared) {
    items.push({
      label: `%${name}`,
      kind: 6, // CompletionItemKind.Variable
      detail: 'transient variable',
      insertText: name,
      documentation: decl.fields && decl.fields.length > 0
        ? `Fields: ${decl.fields.join(', ')}`
        : undefined,
    });
  }
  return items;
}

function getTransientDotPathCompletions(varName: string, workspace: WorkspaceModel): CompletionItem[] {
  const declared = workspace.variables.getDeclaredTransient();
  const decl = declared.get(varName);
  if (!decl || !decl.fields || decl.fields.length === 0) return [];

  return decl.fields.map(field => ({
    label: field,
    kind: 5, // CompletionItemKind.Field
    detail: `field of %${varName}`,
  }));
}

function getPassageNameCompletions(workspace: WorkspaceModel): CompletionItem[] {
  const passages = workspace.passages.getAllPassages();
  if (passages.length === 0) return [];

  return passages.map(p => ({
    label: p.name,
    kind: 18, // CompletionItemKind.Reference
    detail: p.uri,
  }));
}

// ---------------------------------------------------------------------------
// Plugin wrapper (LSP integration)
// ---------------------------------------------------------------------------

export const completionsPlugin: SpindlePlugin = {
  id: 'completions',
  capabilities: {
    completionProvider: {
      triggerCharacters: ['{', '$', '_', '@', '%', '[', '.'],
    },
  },
  initialize(ctx: PluginContext) {
    ctx.connection.onCompletion((params) => {
      const uri = params.textDocument.uri;
      const position: Position = {
        line: params.position.line,
        character: params.position.character,
      };
      const triggerChar = params.context?.triggerCharacter;
      return getCompletions(uri, position, triggerChar, ctx.workspace);
    });
  },
};
