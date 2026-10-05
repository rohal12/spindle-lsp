import type { CompletionItem } from 'vscode-languageserver';
import type { Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { parseDocumentMacros, buildLineStarts } from '../core/parsing/macro-parser.js';
import { inAttributeValue } from '../core/parsing/html-scanner.js';
import { isMarkupPassage } from '../core/parsing/passage-parser.js';
import { bracketLinkMismatch } from '../core/parsing/link-runtime.js';
import { parseLinks } from '../core/parsing/link-parser.js';

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
    inAttributeValue(text, (buildLineStarts(text)[position.line] ?? 0) + position.character - 1, workspace.capabilities);

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

  // The code and prose of passages Spindle does not read as markup (script,
  // stylesheet, StoryData, StoryVariables, ...) are not story syntax: offer nothing there
  const passage = workspace.passages.getPassageAt(uri, position.line);
  if (passage && !isMarkupPassage(passage)) return [];

  const fullLine = lines[position.line].replace(/\r$/, '');
  // The edit replaces the typed prefix, and the identifier characters that
  // follow the cursor, so accepting an item never duplicates what is there
  // (hyphenated names, `$` sigils and spaces are not word characters to every client).
  const editFor = (items: CompletionItem[], typed: number, tailPattern = /^[\w$]*/): CompletionItem[] => {
    const tail = tailPattern.exec(fullLine.substring(position.character))![0].length;
    const range = {
      start: { line: position.line, character: position.character - typed },
      end: { line: position.line, character: position.character + tail },
    };
    return items.map(item => ({ ...item, textEdit: { range, newText: item.insertText ?? item.label } }));
  };

  // --- Context: dot-path field `%var.` ---
  const transientDotPathMatch = /%([\w$]+)\.([A-Za-z_$][\w$]*)?$/.exec(lineText);
  if (transientDotPathMatch) {
    return editFor(getTransientDotPathCompletions(transientDotPathMatch[1], workspace), (transientDotPathMatch[2] ?? '').length);
  }

  // --- Context: dot-path field `$var.` ---
  const dotPathMatch = /\$([\w$]+)\.([A-Za-z_$][\w$]*)?$/.exec(lineText);
  if (dotPathMatch) {
    return editFor(getDotPathCompletions(dotPathMatch[1], workspace), (dotPathMatch[2] ?? '').length);
  }

  // --- Context: story variable `$` ---
  const storyVar = /\$([A-Za-z_$]?[\w$]*)$/.exec(lineText);
  if (storyVar && !/\$[A-Za-z_$][\w$]*\./.test(lineText)) {
    return editFor(getStoryVariableCompletions(workspace), storyVar[1].length);
  }

  // --- Context: temporary variable `_` ---
  const tempVar = /_([A-Za-z_$]?[\w$]*)$/.exec(lineText);
  if (tempVar) {
    return editFor(getTempVariableCompletions(text), tempVar[1].length);
  }

  // --- Context: local variable `@` ---
  const localVar = /@([A-Za-z_$]?[\w$]*)$/.exec(lineText);
  if (localVar) {
    return editFor(getLocalVariableCompletions(text), localVar[1].length);
  }

  // --- Context: transient variable `%` ---
  const transientVar = /%([A-Za-z_$]?[\w$]*)$/.exec(lineText);
  if (transientVar && !/%[A-Za-z_$][\w$]*\./.test(lineText)) {
    return editFor(getTransientVariableCompletions(workspace), transientVar[1].length);
  }

  // --- Context: passage link `[[` ---
  const link = /\[\[([^\]]*)$/.exec(lineText);
  if (link) {
    if (inAttribute()) return [];
    // The target of the whole link text (up to `]]`), as Spindle's parseLink splits it
    const rest = fullLine.substring(position.character);
    const inner = link[1] + (/^(?:(?!\]\]).)*/.exec(rest)![0]);
    const target = linkTargetSpan(inner);
    if (link[1].length < target.start || link[1].length > target.end) return [];
    const range = {
      start: { line: position.line, character: position.character - (link[1].length - target.start) },
      end: { line: position.line, character: position.character + (target.end - link[1].length) },
    };
    return getPassageNameCompletions(workspace, workspace.capabilities.linkQuoteEscapes)
      .map(item => ({ ...item, textEdit: { range, newText: item.insertText ?? item.label } }));
  }

  // --- Context: macro invocation `{` or `{partial` ---
  const macro = /(?:^|[^\\])\{([A-Za-z\w-]*)$/.exec(lineText);
  if (macro) {
    return inAttribute() ? [] : editFor(getMacroCompletions(workspace), macro[1].length, /^[\w-]*/);
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
  const macros = parseDocumentMacros(text, passages, (name) => workspace.isContainer(name), workspace.capabilities);

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

/**
 * Where the target is in a link's inner text, as Spindle's tokenizer splits
 * it (`display|target`, then `display->target`, then `target<-display`, else
 * the whole text). The span runs from just after the separator, whitespace
 * after it excluded, to the end of the target text.
 */
function linkTargetSpan(inner: string): { start: number; end: number } {
  const skip = (from: number) => from + /^\s*/.exec(inner.slice(from))![0].length;
  const pipe = inner.indexOf('|');
  if (pipe !== -1) return { start: skip(pipe + 1), end: inner.length };
  const arrow = inner.indexOf('->');
  if (arrow !== -1) return { start: skip(arrow + 2), end: inner.length };
  const reverse = inner.indexOf('<-');
  if (reverse !== -1) return { start: 0, end: reverse };
  return { start: skip(0), end: inner.length };
}

/**
 * Whether `[[name]]` reads back as a link to `name`: a name with `|`, `->`,
 * `<-`, `]]` or edge whitespace names another passage (or none), and before
 * Spindle 0.51.1 a double quote or line break sends the click elsewhere. Such
 * a passage cannot be linked with brackets, so it is not offered there.
 */
function linkable(name: string, quoteEscapes: boolean): boolean {
  const links = parseLinks(`[[${name}]]`);
  return links.length === 1 && links[0].name === name && !bracketLinkMismatch('label', name, quoteEscapes);
}

function getPassageNameCompletions(workspace: WorkspaceModel, quoteEscapes = false): CompletionItem[] {
  const passages = workspace.passages.getAllPassages().filter(p => linkable(p.name, quoteEscapes));
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
