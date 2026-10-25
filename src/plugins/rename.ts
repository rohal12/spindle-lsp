import { ErrorCodes, ResponseError } from 'vscode-languageserver';
import type { Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import { readStoryData } from '../core/workspace/story-data.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { lexJs, parseBoundVariable, parseDeclarations, passagePieces, pieceOffset, type Piece, type BoundVariable } from '@rohal12/spindle/tooling';
import { collectVariableReferences } from '../core/parsing/executable-refs.js';
import { sourceView, viewIndex } from '../core/markup/source-view.js';
import { positionToOffset, splitLines } from '../core/text.js';
import { bracketLinkMismatch } from '../core/parsing/link-runtime.js';
import { encodeEnclosingMarkup, passageRefAt, type PassageRef } from '../core/markup/passage-refs.js';
import type { PassageMarkup } from '../core/markup/passage-markup.js';
import { encodeStringLiteralBody } from '../core/parsing/js-string-literal.js';
import { documentMacroHeads, macroHeadAt } from '../core/markup/macro-heads.js';
import { encodePassageName, isReservedPassageName, parsePassageHeader } from '../core/parsing/passage-parser.js';
import {
  findPassageRefs,
  findVariableReferences,
  findTransientReferences,
  findWidgetReferences,
  variableAt,
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
      // Each reference spells its name in its own context (bracket link,
      // JavaScript string, text); encode per reference and fail before
      // returning any edit when a spelling cannot hold the name. The error
      // names the reference that cannot.
      // Renaming to its own name changes nothing; re-spelling references
      // could only alter their meaning.
      if (newName === symbol.name) return new Map();
      // A name another passage already holds would merge the two passages
      // (duplicate headers, every link ambiguous): reject before any edit.
      if (workspace.passages.getPassage(newName)) {
        throw new RenameError(`Cannot rename to ${JSON.stringify(newName)}: a passage with that name already exists.`).at(uri, symbol.range);
      }
      for (const documentUri of workspace.documents.getUris()) {
        const doc = workspace.markup.get(documentUri);
        if (!doc) continue;
        for (const head of documentMacroHeads(doc)) {
          if (!head.closing && workspace.getEffectiveMacro(head.name) && workspace.macros.hasUnsafeConfiguredPassages(head.name)) {
            throw new RenameError(`Cannot rename: {${head.name}} has configured passage parameters whose positions are ambiguous, repeated or conflict with its runtime signature.`)
              .at(documentUri, head.range);
          }
        }
      }
      const refEdits: Array<{ uri: string; ref: PassageRef; text: string }> = [];
      for (const { uri: refUri, ref } of findPassageRefs(symbol.name, workspace)) {
        try {
          refEdits.push({ uri: refUri, ref, text: encodePassageRefName(ref, newName) });
        } catch (error) {
          if (error instanceof RenameError) throw error.at(refUri, ref.range);
          throw error;
        }
      }
      // What each spelling means is the tooling API's to say: read the
      // rewritten passages back before any edit is returned
      for (const [passage, edits] of groupByPassage(refEdits)) {
        const broken = misreadRewrite(passage, edits, symbol.name, newName);
        if (broken) {
          const refUri = refEdits.find(edit => edit.ref === broken)!.uri;
          throw unrepresentable(newName, describeRef(broken)).at(refUri, broken.range);
        }
      }
      // The header spells the name with Twee escapes (`A\[B`); links and
      // macro arguments use the plain name.
      if (isReservedPassageName(newName)) {
        throw new RenameError(`Cannot rename to ${JSON.stringify(newName)}: it is a reserved passage name with a fixed meaning.`).at(uri, symbol.range);
      }
      const encoded = encodePassageName(newName);
      for (const declaration of workspace.passages.getPassages(symbol.name)) {
        if (encoded === undefined) {
          const reason = /[\r\n]/.test(newName) ? 'a passage header is a single line' : 'a passage header cannot represent that name exactly';
          throw new RenameError(`Cannot rename to ${JSON.stringify(newName)}: ${reason}.`).at(declaration.uri, declaration.nameRange);
        }
        addEdit(declaration.uri, declaration.nameRange, encoded);
      }
      for (const { uri: refUri, ref, text } of refEdits) addEdit(refUri, ref.range, text);
      preserveEntryPassage(symbol.name, newName, workspace, addEdit);
      break;
    }

    case 'variable': {
      const bareName = newName.startsWith('$') ? newName.slice(1) :
                       newName.startsWith('%') ? newName.slice(1) : newName;
      // Spindle's grammar is the sigil followed by word characters
      // (`declarationRegex` in story-variables, `[\w.]` in the tokenizer):
      // digit-leading names are valid and an internal `$` is not.
      if (!/^\w+$/.test(bareName)) {
        throw new RenameError(
          `Cannot rename to ${JSON.stringify(newName)}: a variable name must be word characters only (letters, digits and _; no \`$\`, \`%\`, \`.\` or spaces).`,
        ).at(uri, symbol.range);
      }
      // In code `%5` is the modulo operator, not a transient (`transform('%5')`
      // throws), so a transient cannot be named by digits first.
      if (symbol.sigil === '%' && /^\d/.test(bareName)) {
        throw new RenameError(
          `Cannot rename to ${JSON.stringify(newName)}: a transient name cannot start with a digit, \`%5\` is the modulo operator in code.`,
        ).at(uri, symbol.range);
      }
      const declaration = parseDeclarations(`${symbol.sigil}${bareName} = 0`, symbol.sigil);
      if (declaration.errors.length || declaration.declarations[0]?.name !== bareName) {
        throw new RenameError(`Cannot rename to ${JSON.stringify(newName)}: ${declaration.errors[0]?.message ?? 'invalid variable name'}.`).at(uri, symbol.range);
      }
      if (bareName === symbol.name) return new Map();
      if (workspace.variables.getDeclared().has(bareName) || workspace.variables.getDeclaredTransient().has(bareName)) {
        throw new RenameError(`Cannot rename to ${JSON.stringify(newName)}: a variable with that name already exists.`).at(uri, symbol.range);
      }
      const refs = symbol.sigil === '%'
        ? findTransientReferences(symbol.name, workspace, true)
        : findVariableReferences(symbol.name, workspace, true);
      // Input bindings supply editable roots; code references retain their
      // sigil and any property path. Read each passage's binding spans once.
      const bindings = new Map<PassageMarkup, Map<number, BoundVariable>>();
      for (const ref of refs) {
        const doc = workspace.markup.get(ref.uri)!;
        const passage = doc.passageAt(ref.range.start)!;
        const start = passage.contentOffset(positionToOffset(ref.range.start, doc.lineStarts));
        const end = passage.contentOffset(positionToOffset(ref.range.end, doc.lineStarts));
        let byStart = bindings.get(passage);
        if (!byStart) {
          byStart = new Map(collectVariableReferences(passage).flatMap(ref => ref.binding ? [[ref.start, ref.binding] as const] : []));
          bindings.set(passage, byStart);
        }
        const binding = byStart.get(start);
        if (binding && binding.end === end) {
          let spelling = bareName;
          if (!binding.explicitSigil) {
            // Some story-variable names need a literal $ in an input binding.
            // Let the runtime reader decide whether the sigilless form works.
            try { parseBoundVariable(spelling); }
            catch { spelling = `$${spelling}`; }
          }
          addEdit(ref.uri, passage.range(binding.nameStart, binding.nameEnd), spelling);
          continue;
        }
        const view = sourceView(passage, start, end);
        const index = viewIndex(view, start);
        let base: [number, number] | undefined;
        lexJs(view.text.slice(index, viewIndex(view, end)), {
          variable(sigil, name, at, _nesting, nameEnd) {
            if (at === 0 && sigil === symbol.sigil && name === symbol.name) {
              base = [pieceOffset(view, index + 1), pieceOffset(view, index + nameEnd)];
            }
          },
        });
        if (!base) throw new RenameError('Cannot locate the variable name safely.').at(ref.uri, ref.range);
        addEdit(ref.uri, passage.range(...base), bareName);
      }
      break;
    }

    case 'widget': {
      if (newName === symbol.name) return new Map();
      if (!/^[A-Za-z][\w-]*$/.test(newName)) {
        throw new RenameError(
          `Cannot rename to ${JSON.stringify(newName)}: a widget name must start with a letter and contain only letters, digits, _ and - to be called as {name}.`,
        ).at(uri, symbol.range);
      }
      const widget = workspace.widgets.getWidget(symbol.name);
      if (widget && !widget.block && workspace.macros.isBlock(symbol.name)) {
        throw new RenameError('Cannot rename this inline widget: its current name inherits a macro container body that the new name would lose.')
          .at(uri, symbol.range);
      }
      if (workspace.macros.getMacro(newName)) {
        throw new RenameError(
          `Cannot rename to ${JSON.stringify(newName)}: a macro of that name already exists.`,
        ).at(uri, symbol.range);
      }
      const destination = workspace.widgets.getWidget(newName);
      if (destination && destination.name.toLowerCase() !== symbol.name.toLowerCase()) {
        throw new RenameError(`Cannot rename to ${JSON.stringify(newName)}: a widget with that name already exists.`).at(uri, symbol.range);
      }
      // Rename invocations
      const invocationRefs = findWidgetReferences(symbol.name, workspace, false);
      for (const ref of invocationRefs) {
        addEdit(ref.uri, ref.range, newName);
      }

      // Rename definition (just the name, keeping any quotes)
      if (widget) {
        addEdit(widget.uri, widget.nameRange, newName);
      }
      break;
    }
  }

  return edits;
}

/** Preserve the compiler's explicit StoryData start, or its implicit Start. */
function preserveEntryPassage(
  oldName: string,
  newName: string,
  workspace: WorkspaceModel,
  addEdit: (uri: string, range: Range, text: string) => void,
): void {
  const storyData = workspace.passages.getPassages('StoryData');
  for (const declaration of storyData) {
    const passage = workspace.markup.get(declaration.uri)!.passages.find(p => p.passage === declaration)!;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(passage.content);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    } catch {
      throw new RenameError('Cannot preserve the entry passage: StoryData must contain a valid JSON object.').at(declaration.uri, declaration.nameRange);
    }
    const start = readStoryData(passage.content).start || 'Start';
    if (start !== oldName) continue;
    if (Object.entries(data).some(([key, value]) => isEntryField(key) && typeof value !== 'string')) {
      throw new RenameError('Cannot preserve the entry passage: StoryData.start must be a string.').at(declaration.uri, declaration.nameRange);
    }

    // JSON is already validated. Use the public lexer to locate top-level
    // keys without changing whitespace, escaped keys, or nested metadata.
    let depth = 0;
    let startValue = false;
    let replaced = false;
    lexJs(passage.content, {
      code(ch) {
        if (ch === '{' || ch === '[') depth++;
        if (ch === '}' || ch === ']') depth--;
        if (ch === ',') startValue = false;
      },
      literal(text, index) {
        if (depth !== 1 || !text.startsWith('"')) return;
        const isKey = /^\s*:/.test(passage.content.slice(index + text.length));
        if (isKey) startValue = isEntryField(JSON.parse(text));
        else if (startValue) {
          addEdit(declaration.uri, passage.range(index, index + text.length), JSON.stringify(newName));
          replaced = true;
        }
      },
    });
    if (!replaced) {
      const index = passage.content.indexOf('{') + 1;
      addEdit(declaration.uri, passage.range(index, index), `"start":${JSON.stringify(newName)}${Object.keys(data).length ? ',' : ''}`);
    }
  }
  if (storyData.length === 0 && oldName === 'Start') {
    const declaration = workspace.passages.getPassage(oldName)!;
    const doc = workspace.markup.get(declaration.uri)!;
    const end = doc.passages.at(-1)!.position(doc.passages.at(-1)!.content.length);
    const eol = /\r\n|[\r\n]/.exec(doc.text)?.[0] ?? '\n';
    addEdit(declaration.uri, { start: end, end }, `${eol}${eol}:: StoryData${eol}${JSON.stringify({ start: newName })}${eol}`);
  }
}

/** Ask the compiler which source keys name the entry, including Unicode case variants. */
function isEntryField(key: string): boolean {
  return readStoryData(JSON.stringify({ [key]: 'Start' })).start === 'Start';
}

/**
 * A rename that cannot be applied without corrupting a reference. The whole
 * request fails (a partial WorkspaceEdit would leave the story inconsistent);
 * `uri` and `range` locate the offending reference or declaration.
 */
export class RenameError extends Error {
  uri?: string;
  range?: Range;

  /** The same error, naming the 1-based position it concerns. */
  at(uri: string, range: Range): RenameError {
    const located = new RenameError(
      `${this.message} (at ${uri}:${range.start.line + 1}:${range.start.character + 1})`,
    );
    located.uri = uri;
    located.range = range;
    return located;
  }
}

function unrepresentable(newName: string, where: string): RenameError {
  return new RenameError(`Cannot rename to ${JSON.stringify(newName)}: it cannot be written inside ${where}.`);
}

/** Where a reference is written, for a message. */
function describeRef(ref: PassageRef): string {
  switch (ref.form) {
    case 'bracket': return 'a [[link]] (it cannot contain |, ->, <-, [[, ]], a line break, or leading/trailing whitespace)';
    case 'text': return `the text of {${ref.macro}}`;
    case 'quoted': return `a ${ref.quote ?? '"'}-quoted {${ref.macro}} argument`;
  }
}

/**
 * Spell `newName` for the reference's context so that Spindle reads the
 * same name back: a bracket link target as written, a quoted argument as a
 * JavaScript string literal (the escapes of quote, backslash and line breaks
 * included; `passageTarget` reads it), and, inside the quoted argument of
 * another macro (a label), once more with that string's escapes. Throws
 * RenameError when the context cannot represent it. computeRename also reads
 * the rewritten passage back, which decides what only the markup can (a name
 * with `->` in a link, a quote in an attribute value).
 */
export function encodePassageRefName(ref: PassageRef, newName: string): string {
  let spelling: string;
  switch (ref.form) {
    case 'bracket':
      // The link macro that renders the link must carry the name: a line
      // break makes its quoted target an expression, and the click fails
      if (bracketLinkMismatch('label', newName)) throw unrepresentable(newName, describeRef(ref));
      spelling = newName;
      break;
    case 'quoted':
      spelling = encodeStringLiteralBody(newName, ref.quote ?? '"');
      break;
    case 'text':
      spelling = newName;
      break;
  }
  return encodeEnclosingMarkup(ref.passage, ref.start, ref.end, spelling);
}

function groupByPassage(edits: Array<{ ref: PassageRef; text: string }>): Map<PassageMarkup, Array<{ ref: PassageRef; text: string }>> {
  const groups = new Map<PassageMarkup, Array<{ ref: PassageRef; text: string }>>();
  for (const edit of edits) {
    const group = groups.get(edit.ref.passage);
    if (group) group.push(edit);
    else groups.set(edit.ref.passage, [edit]);
  }
  return groups;
}

/** What a piece is, for comparing a passage before and after a rename (`rename` maps passage names). */
function signature(piece: Piece, rename: (name: string) => string): string {
  switch (piece.kind) {
    case 'passage': return `passage ${piece.macro} ${rename(piece.name)}`;
    case 'code': return `code ${piece.goal} ${piece.macro ?? ''} ${piece.code}`;
    case 'text': return `text ${piece.where}`;
    case 'argument-error': return `error ${piece.macro}`;
  }
}

/**
 * Apply the edits to the passage and read it back with the tooling API: the
 * rewrite must name `newName` where it named `oldName` and read every other
 * piece as before. Returns the first reference that does not, else null.
 */
function misreadRewrite(
  passage: PassageMarkup,
  edits: Array<{ ref: PassageRef; text: string }>,
  oldName: string,
  newName: string,
): PassageRef | null {
  let content = passage.content;
  for (const { ref, text } of [...edits].sort((a, b) => b.ref.start - a.ref.start)) {
    content = content.slice(0, ref.start) + text + content.slice(ref.end);
  }
  const before = passage.pieces.map(piece => signature(piece, name => (name === oldName ? newName : name)));
  const after = passagePieces(content, passage.doc.context.macros).map(piece => signature(piece, name => name));
  const at = before.findIndex((sig, index) => sig !== after[index]);
  if (at === -1 && before.length === after.length) return null;
  const index = at === -1 ? before.length : at;
  const owner = edits.filter(edit => edit.ref.piece <= index).at(-1) ?? edits[0];
  return owner.ref;
}

// ---------------------------------------------------------------------------
// Symbol resolution
// ---------------------------------------------------------------------------

interface SymbolInfo {
  kind: 'passage' | 'variable' | 'widget';
  name: string;
  range: Range;
  /** Variable namespace: `$` story variable or `%` transient. */
  sigil?: '$' | '%';
}

function resolveSymbolAtCursor(
  uri: string,
  position: Position,
  workspace: WorkspaceModel,
): SymbolInfo | null {
  const text = workspace.documents.getText(uri);
  if (text === undefined || !workspace.hasPassages(uri)) return null;

  const lines = splitLines(text);
  if (position.line >= lines.length) return null;
  const line = lines[position.line];

  // --- Passage header ---
  const header = parsePassageHeader(line, position.line);
  if (header) {
    const { start, end } = header.nameRange;
    if (position.character >= start.character && position.character <= end.character) {
      // A reserved name (StoryInit, StoryVariables, ...) is the passage's role, not a label
      if (isReservedPassageName(header.name)) return null;
      return { kind: 'passage', name: header.name, range: header.nameRange };
    }
  }

  // --- $variable / %transient ---
  const variable = variableAt(uri, position, workspace);
  if (variable) {
    return { kind: 'variable', name: variable.name, sigil: variable.sigil, range: variable.range };
  }

  // --- Widget definition: {widget "name" ...} ---
  const declaration = workspace.widgets.definitionAt(uri, position);
  if (declaration) return { kind: 'widget', name: declaration.name, range: declaration.nameRange };

  // --- Widget invocation: {widgetName ...} or block widget closing tag {/widgetName} ---
  const doc = workspace.markup.get(uri);
  const head = doc && macroHeadAt(doc, position);
  if (head) {
    const widget = workspace.widgets.getWidget(head.name);
    if (!workspace.getEffectiveMacro(head.name) && widget && (!head.closing || workspace.isContainer(head.name))) {
      return { kind: 'widget', name: head.name, range: head.range };
    }
  }

  // --- Passage name written out: [[link]] or a quoted macro argument ---
  const passageRef = doc && passageRefAt(doc, position);
  if (passageRef && workspace.passages.getPassage(passageRef.name) && !isReservedPassageName(passageRef.name)) {
    return { kind: 'passage', name: passageRef.name, range: passageRef.range };
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
      let editsMap: Map<string, RenameEdit[]>;
      try {
        editsMap = computeRename(
          params.textDocument.uri,
          { line: params.position.line, character: params.position.character },
          params.newName,
          ctx.workspace,
        );
      } catch (error) {
        if (error instanceof RenameError) {
          return new ResponseError(ErrorCodes.InvalidParams, error.message);
        }
        throw error;
      }

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
