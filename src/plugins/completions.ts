import type { CompletionItem } from 'vscode-languageserver';
import { tokenizeMarkupTolerant } from '@rohal12/spindle/tooling';
import type { Position } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { bracketLinkMismatch } from '../core/parsing/link-runtime.js';
import { markupAt, type MarkupCursor } from './markup-cursor.js';
import { variableUses } from './markup-symbols.js';

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
 * Which of them applies is read from Spindle's tokens around the cursor (see
 * MarkupCursor): `{` starts a macro in an HTML attribute value or a label, as
 * it does in a passage, but not in a comment or in a macro's arguments; `[[`
 * is text there.
 */
export function getCompletions(
  uri: string,
  position: Position,
  triggerChar: string | undefined,
  workspace: WorkspaceModel,
): CompletionItem[] {
  const cursor = markupAt(workspace, uri, position);
  // The code and prose of passages Spindle does not read as markup (script,
  // stylesheet, StoryData, StoryVariables, ...) are not story syntax: offer nothing there
  if (!cursor?.passage.isMarkup) return [];
  const { passage, content, at } = cursor;
  const before = cursor.lineBefore;

  /** The edit that replaces `[start, end)` of the passage with an item's text. */
  const editing = (items: CompletionItem[], start: number, end: number): CompletionItem[] => {
    const range = passage.range(start, end);
    return items.map(item => ({ ...item, textEdit: { range, newText: item.insertText ?? item.label } }));
  };
  // The edit replaces the typed prefix, and the identifier characters that
  // follow the cursor, so accepting an item never duplicates what is there
  // (hyphenated names, `$` sigils and spaces are not word characters to every client).
  const typedEdit = (items: CompletionItem[], typed: number, tailPattern = /^[\w$]*/): CompletionItem[] =>
    editing(items, at - typed, at + tailPattern.exec(content.slice(at))![0].length);

  // --- Context: closing macro `{/` ---
  const head = cursor.headBeingTyped();
  if (head?.closing) {
    // The edit replaces the typed `{/name` prefix (and an already-present
    // `name}` tail) so accepting never duplicates braces or slashes.
    const tail = /^[\w-]*\}?/.exec(content.slice(at))![0].length;
    return editing(getClosingMacroCompletions(cursor, head.brace), head.brace, at + tail);
  }

  // --- Context: dot-path field `%var.` ---
  const transientDotPathMatch = /%([\w$]+)\.([A-Za-z_$][\w$]*)?$/.exec(before);
  if (transientDotPathMatch) {
    return typedEdit(getDotPathCompletions('%', transientDotPathMatch[1], workspace), (transientDotPathMatch[2] ?? '').length);
  }

  // --- Context: dot-path field `$var.` ---
  const dotPathMatch = /\$([\w$]+)\.([A-Za-z_$][\w$]*)?$/.exec(before);
  if (dotPathMatch) {
    return typedEdit(getDotPathCompletions('$', dotPathMatch[1], workspace), (dotPathMatch[2] ?? '').length);
  }

  // --- Context: story variable `$` ---
  const storyVar = /\$([A-Za-z_$]?[\w$]*)$/.exec(before);
  if (storyVar) {
    return typedEdit(getVariableCompletions('$', workspace), storyVar[1].length);
  }

  // --- Context: temporary variable `_` ---
  const tempVar = /_([A-Za-z_$]?[\w$]*)$/.exec(before);
  if (tempVar) {
    return typedEdit(getDocumentVariableCompletions('_', cursor, workspace), tempVar[1].length);
  }

  // --- Context: local variable `@` ---
  const localVar = /@([A-Za-z_$]?[\w$]*)$/.exec(before);
  if (localVar) {
    return typedEdit(getDocumentVariableCompletions('@', cursor, workspace), localVar[1].length);
  }

  // --- Context: transient variable `%` ---
  const transientVar = /%([A-Za-z_$]?[\w$]*)$/.exec(before);
  if (transientVar) {
    return typedEdit(getVariableCompletions('%', workspace), transientVar[1].length);
  }

  // --- Context: passage link `[[` ---
  const target = cursor.linkTarget();
  if (target) return editing(getPassageNameCompletions(workspace), target.start, target.end);

  // --- Context: macro invocation `{` or `{partial` ---
  if (head) return typedEdit(getMacroCompletions(workspace), head.typed.length, /^[\w-]*/);

  return [];
}

// ---------------------------------------------------------------------------
// Sub-functions
// ---------------------------------------------------------------------------

/** `{/name}` for each block macro left open at the `{`, innermost first. */
function getClosingMacroCompletions(cursor: MarkupCursor, brace: number): CompletionItem[] {
  const names = [...new Set(cursor.openBlocks(brace).map(macro => macro.name))];
  return names.map((name, idx) => ({
    label: `{/${name}}`,
    kind: 14, // CompletionItemKind.Keyword
    detail: `Close {${name}}`,
    sortText: String(idx).padStart(3, '0'),
    filterText: `{/${name}}`,
    insertText: `{/${name}}`,
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

const VARIABLE_DETAIL = { $: 'story variable', '%': 'transient variable', _: 'temporary variable', '@': 'local/parameter variable' } as const;

/** The declared `$` story variables or `%` transient variables. */
function getVariableCompletions(sigil: '$' | '%', workspace: WorkspaceModel): CompletionItem[] {
  const declared = sigil === '$' ? workspace.variables.getDeclared() : workspace.variables.getDeclaredTransient();
  return [...declared].map(([name, decl]) => ({
    label: `${sigil}${name}`,
    kind: 6, // CompletionItemKind.Variable
    detail: VARIABLE_DETAIL[sigil],
    insertText: name,
    documentation: decl.fields && decl.fields.length > 0
      ? `Fields: ${decl.fields.join(', ')}`
      : undefined,
  }));
}

/**
 * The `_temp` or `@local` variables the document's markup uses, and the
 * parameters of the widgets it defines.
 */
function getDocumentVariableCompletions(sigil: '_' | '@', cursor: MarkupCursor, workspace: WorkspaceModel): CompletionItem[] {
  const { doc } = cursor.passage;
  const names = new Set<string>();
  for (const passage of doc.passages) {
    for (const use of variableUses(passage)) if (use.sigil === sigil) names.add(use.name);
  }
  for (const widget of workspace.widgets.getAllWidgets()) {
    if (widget.uri !== doc.uri) continue;
    for (const param of widget.params) if (param[0] === sigil) names.add(param.slice(1));
  }
  return [...names].map(name => ({
    label: `${sigil}${name}`,
    kind: 6, // CompletionItemKind.Variable
    detail: VARIABLE_DETAIL[sigil],
    insertText: name,
  }));
}

function getDotPathCompletions(sigil: '$' | '%', varName: string, workspace: WorkspaceModel): CompletionItem[] {
  const declared = sigil === '$' ? workspace.variables.getDeclared() : workspace.variables.getDeclaredTransient();
  const decl = declared.get(varName);
  if (!decl || !decl.fields || decl.fields.length === 0) return [];

  return decl.fields.map(field => ({
    label: field,
    kind: 5, // CompletionItemKind.Field
    detail: `field of ${sigil}${varName}`,
  }));
}

/**
 * Whether `[[name]]` reads back as a link to `name`: a name with `|`, `->`,
 * `<-`, `]]` or edge whitespace names another passage (or none), and one
 * the link macro cannot carry sends the click elsewhere. Such a passage
 * cannot be linked with brackets, so it is not offered there.
 */
function linkable(name: string): boolean {
  const { tokens } = tokenizeMarkupTolerant(`[[${name}]]`);
  const [link] = tokens;
  return tokens.length === 1 && link.type === 'link' && link.target === name && !bracketLinkMismatch('label', name, true);
}

function getPassageNameCompletions(workspace: WorkspaceModel): CompletionItem[] {
  return workspace.passages.getAllPassages().filter(p => linkable(p.name)).map(p => ({
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
