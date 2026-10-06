import { ErrorCodes, ResponseError } from 'vscode-languageserver';
import type { Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { bracketLinkMismatch } from '../core/parsing/link-runtime.js';
import { findPassageRefAt, isVerbatimBareName, parseLinks, resolveLinkMacroTarget, type LinkRuntimeOptions, type PassageRef } from '../core/parsing/link-parser.js';
import { encodeStringLiteralBody } from '../core/parsing/js-string-literal.js';
import { macroHeadNameAt } from '../core/parsing/macro-parser.js';
import { isReservedPassageName, parsePassageHeader } from '../core/parsing/passage-parser.js';
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
      // Each reference spells its target in its own context (bracket link,
      // JavaScript string, MacroLink string); encode per reference and fail
      // before returning any edit when a spelling cannot hold the name. The
      // error names the reference that cannot.
      const refEdits: Array<{ uri: string; range: Range; text: string }> = [];
      for (const { uri: refUri, ref } of findPassageRefs(symbol.name, workspace)) {
        try {
          refEdits.push({ uri: refUri, range: ref.range, text: encodePassageRefName(ref, newName, workspace.capabilities) });
        } catch (error) {
          if (error instanceof RenameError) throw error.at(refUri, ref.range);
          throw error;
        }
      }
      // The header spells the name with Twee escapes (`A\[B`); links and
      // macro arguments use the plain name.
      if (isReservedPassageName(newName)) {
        throw new RenameError(`Cannot rename to ${JSON.stringify(newName)}: it is a reserved passage name with a fixed meaning.`).at(uri, symbol.range);
      }
      for (const declaration of workspace.passages.getPassages(symbol.name)) {
        const problem = passageHeaderProblem(newName);
        if (problem) throw new RenameError(`Cannot rename to ${JSON.stringify(newName)}: ${problem}.`).at(declaration.uri, declaration.nameRange);
        addEdit(declaration.uri, declaration.nameRange, escapePassageName(newName));
      }
      for (const { uri: refUri, range, text } of refEdits) addEdit(refUri, range, text);
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
      const refs = symbol.sigil === '%'
        ? findTransientReferences(symbol.name, workspace, true)
        : findVariableReferences(symbol.name, workspace, true);
      // Reference ranges start with the sigil and may continue with a
      // property path (`$player.health`): replace only the base identifier.
      for (const ref of refs) {
        const start = ref.range.start.character + 1;
        addEdit(ref.uri, {
          start: { line: ref.range.start.line, character: start },
          end: { line: ref.range.start.line, character: start + symbol.name.length },
        }, bareName);
      }
      break;
    }

    case 'widget': {
      if (!/^[A-Za-z][\w-]*$/.test(newName)) {
        throw new RenameError(
          `Cannot rename to ${JSON.stringify(newName)}: a widget name must start with a letter and contain only letters, digits, _ and - to be called as {name}.`,
        ).at(uri, symbol.range);
      }
      if (workspace.macros.getMacro(newName)) {
        throw new RenameError(
          `Cannot rename to ${JSON.stringify(newName)}: a macro of that name exists and takes precedence over the widget.`,
        ).at(uri, symbol.range);
      }
      // Rename invocations
      const invocationRefs = findWidgetReferences(symbol.name, workspace, false);
      for (const ref of invocationRefs) {
        addEdit(ref.uri, ref.range, newName);
      }

      // Rename definition (just the name, keeping any quotes)
      const widget = workspace.widgets.getWidget(symbol.name);
      if (widget) {
        addEdit(widget.uri, widget.nameRange, newName);
      }
      break;
    }
  }

  return edits;
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

/** Why a passage header cannot hold `name`, or null when it can. */
function passageHeaderProblem(name: string): string | null {
  if (name.trim() === '') return 'a passage name cannot be empty';
  if (/[\r\n]/.test(name)) return 'a passage header is a single line, so the name cannot contain a line break';
  if (name !== name.trim()) return 'a passage name cannot start or end with whitespace';
  return null;
}

/**
 * Spell `newName` for the reference's context so that Spindle reads the
 * same name back. Throws RenameError when the context cannot represent it.
 */
export function encodePassageRefName(ref: PassageRef, newName: string, options: LinkRuntimeOptions = {}): string {
  const unrepresentable = (where: string): RenameError =>
    new RenameError(`Cannot rename to ${JSON.stringify(newName)}: it cannot be written inside ${where}.`);
  const isInclude = ref.source === 'macro' && ref.macro === 'include';
  // Before Spindle 0.51.1 `{include}` removes the first `inline` word from
  // its arguments even inside a quoted target, so the word is spelled with a
  // JavaScript escape (`\u0069nline`) that the evaluator reads back as `i`.
  const encodeInclude = (literal: string): string =>
    isInclude && !options.includeInlineScoped ? literal.replace(/\binline\b/g, '\\u0069nline') : literal;

  switch (ref.form) {
    case 'js-string':
      return encodeInclude(encodeStringLiteralBody(newName, ref.quote ?? '"'));
    case 'bare': {
      // An unquoted target is a text fallback, used only when evaluating it
      // throws. Anything else (`1 + 2`, `a-b`, `true`) evaluates to another
      // value, so quote it. A bare name Spindle 0.51.1+ would read as the
      // `inline` flag is quoted as well.
      if (isVerbatimBareName(newName) && !(isInclude && /\binline\b/.test(newName))) return newName;
      return encodeInclude(`"${encodeStringLiteralBody(newName, '"')}"`);
    }
    case 'link-string': {
      // The link macro reads its quoted arguments with a quote regex: before
      // Spindle 0.51.1 nothing is escaped, from 0.51.1 `\\` and the
      // delimiter are (see link-runtime.ts).
      const quote = ref.quote ?? '"';
      const body = options.linkQuoteEscapes
        ? newName.replace(/\\/g, '\\\\').split(quote).join(`\\${quote}`)
        : newName;
      const probe = resolveLinkMacroTarget(`"label" ${quote}${body}${quote}`, options);
      if (!probe || probe.name !== newName) {
        throw unrepresentable(`a {link} ${quote}-quoted argument (it cannot contain the quote, a line break or a backslash before Spindle 0.51.1)`);
      }
      return body;
    }
    case 'bracket': {
      const probe = parseLinks(`[[${newName}]]`, 0, options);
      if (probe.length !== 1 || probe[0].name !== newName) {
        throw unrepresentable('a [[link]] (it cannot contain |, ->, <-, [[, ]], or leading/trailing whitespace)');
      }
      // The link macro that renders the link must read the name back: before
      // Spindle 0.51.1 a double quote or a line break sends the click elsewhere.
      if (bracketLinkMismatch('label', newName, options.linkQuoteEscapes === true)) {
        throw unrepresentable('a [[link]] (Spindle before 0.51.1 reads the link text with a quote regex, so it cannot contain a double quote or a line break)');
      }
      return newName;
    }
  }
}

/** Escape the Twee header metacharacters (`[ ] { } \`) in a passage name. */
function escapePassageName(name: string): string {
  return name.replace(/[[\]{}\\]/g, '\\$&');
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

  const lines = text.split('\n');
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
  for (const widget of workspace.widgets.getAllWidgets()) {
    const { start, end } = widget.nameRange;
    if (
      widget.uri === uri &&
      position.line === start.line &&
      position.character >= start.character &&
      position.character <= end.character
    ) {
      return { kind: 'widget', name: widget.name, range: widget.nameRange };
    }
  }

  // --- Widget invocation: {widgetName ...} or block widget closing tag {/widgetName} ---
  {
    const head = macroHeadNameAt(text, position, workspace.macroHeadPairing(uri));
    if (head) {
      const widget = workspace.widgets.getWidget(head.name);
      if (!workspace.macros.getMacro(head.name) && widget && (!head.closing || widget.block)) {
        return { kind: 'widget', name: head.name, range: head.range };
      }
    }
  }

  // --- Passage reference in [[link]] or macro arguments (goto, include, link) ---
  const passageRef = findPassageRefAt(text, position, workspace.passages.getPassagesInDocument(uri), workspace.capabilities);
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
