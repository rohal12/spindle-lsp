import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument, isMap, isScalar, stringify as stringifyYaml } from 'yaml';
import type { Diagnostic, Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { DiagnosticCode } from '../core/diagnostic-codes.js';
import { findConfigFile } from '../core/workspace/config-loader.js';
import { missingStoryVariablesOwner } from '../core/workspace/story-variables-owner.js';
import { isMacroSource } from '../core/workspace/macro-sources.js';
import { conditionalExpression, printExpression } from '../core/parsing/attribute-blocks.js';
import { buildLineStarts } from '../core/parsing/macro-parser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeAction {
  title: string;
  kind: string;
  diagnosticCodes: string[];
  /** URI of a file that must be created (empty) before applying `edits`. */
  createFile?: string;
  edits: Array<{ uri: string; range: Range; newText: string }>;
}

export interface CodeActionOptions {
  /** Workspace root (filesystem path or file:// URI) used to locate the project config. */
  workspaceRoot?: string;
}

// ---------------------------------------------------------------------------
// Core code actions function (no LSP dependency)
// ---------------------------------------------------------------------------

/**
 * Compute quick-fix code actions for the given diagnostics.
 *
 * Supported fixes:
 *  - SP100 (undefined macro) -> "Add 'macroName' to <project config>"
 *  - SP200 (undeclared variable) -> "Declare '$varName' in StoryVariables"
 *  - SP202 (no StoryVariables) -> "Create StoryVariables passage"
 *  - SP203 (undeclared transient) -> "Declare '%varName' in StoryTransients"
 *  - SP204 (null variable value) -> "Replace null with 0"
 *  - SP103 ({if C}A{else}B{/if} in an HTML attribute) -> "Rewrite as {C ? 'A' : 'B'}"
 *  - SP103 ({print E} in an HTML attribute) -> "Rewrite as {E}"
 */
export function computeCodeActions(
  uri: string,
  diagnostics: Diagnostic[],
  workspace: WorkspaceModel,
  options: CodeActionOptions = {},
): CodeAction[] {
  const actions: CodeAction[] = [];

  for (const diag of diagnostics) {
    switch (diag.code) {
      case DiagnosticCode.UndefinedMacro: {
        const action = fixUndefinedMacro(uri, diag, workspace, options);
        if (action) actions.push(action);
        break;
      }
      case DiagnosticCode.UndeclaredVariable: {
        const action = fixUndeclaredVariable(diag, workspace);
        if (action) actions.push(action);
        break;
      }
      case DiagnosticCode.NoStoryVariables: {
        const action = fixNoStoryVariables(workspace);
        if (action) actions.push(action);
        break;
      }
      case DiagnosticCode.UndeclaredTransient: {
        const action = fixUndeclaredTransient(diag, workspace);
        if (action) actions.push(action);
        break;
      }
      case DiagnosticCode.NullVariableValue: {
        const action = fixNullVariableValue(uri, diag);
        if (action) actions.push(action);
        break;
      }
      case DiagnosticCode.UnevaluatedAttributeBlock: {
        const action = fixAttributeMacro(uri, diag, workspace);
        if (action) actions.push(action);
        break;
      }
      // No quick fix for other diagnostic codes
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Quick fix: SP100 — Add macro to the project config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_FILENAME = 'spindle.config.yaml';

/** Metadata written for a newly configured macro. */
const NEW_MACRO_ENTRY = { description: '' };

type TextEdit = { range: Range; newText: string };

function fixUndefinedMacro(
  uri: string,
  diag: Diagnostic,
  workspace: WorkspaceModel,
  options: CodeActionOptions,
): CodeAction | null {
  // Extract macro name from message: "Unrecognized macro: {macroName}"
  const match = diag.message.match(/\{(\w[\w-]*)\}/);
  if (!match) return null;

  const macroName = match[1];
  const root = resolveConfigRoot(uri, options.workspaceRoot);
  if (!root) return null;

  const existingPath = findConfigFile(root);
  const configPath = existingPath ?? join(root, DEFAULT_CONFIG_FILENAME);
  const configUri = pathToFileURL(configPath).toString();
  const action = {
    title: `Add '${macroName}' to ${basename(configPath)}`,
    kind: 'quickfix',
    diagnosticCodes: [DiagnosticCode.UndefinedMacro],
  };

  if (!existingPath) {
    const start: Position = { line: 0, character: 0 };
    return {
      ...action,
      createFile: configUri,
      edits: [{
        uri: configUri,
        range: { start, end: start },
        newText: stringifyYaml({ macros: { [macroName]: NEW_MACRO_ENTRY } }),
      }],
    };
  }

  // Prefer the live editor contents when the config is open
  let text = workspace.documents.getText(configUri);
  if (text === undefined) {
    try {
      text = readFileSync(existingPath, 'utf-8');
    } catch {
      return null;
    }
  }

  const edit = configPath.toLowerCase().endsWith('.json')
    ? addMacroToJsonConfig(text, macroName)
    : addMacroToYamlConfig(text, macroName);
  if (!edit) return null;

  return { ...action, edits: [{ uri: configUri, ...edit }] };
}

/**
 * Determine the directory whose config the quick fix should target.
 * Uses the workspace root when known; otherwise walks up from the document's
 * directory to the nearest existing config (falling back to the document's
 * directory), mirroring the CLI's search.
 */
function resolveConfigRoot(uri: string, workspaceRoot: string | undefined): string | null {
  if (workspaceRoot) {
    return workspaceRoot.startsWith('file:') ? fileURLToPath(workspaceRoot) : workspaceRoot;
  }
  if (!uri.startsWith('file:')) return null;

  const docDir = dirname(fileURLToPath(uri));
  let search = docDir;
  for (let i = 0; i < 10; i++) {
    if (findConfigFile(search)) return search;
    const parent = dirname(search);
    if (parent === search) break;
    search = parent;
  }
  return docDir;
}

/** Key path of the `macros` mapping, honouring the legacy `spindle-0` wrapper (see config-loader). */
function macrosPath(root: unknown): string[] {
  const legacy = (root as Record<string, unknown> | null)?.['spindle-0'];
  return legacy !== null && typeof legacy === 'object' ? ['spindle-0', 'macros'] : ['macros'];
}

function definesMacro(macros: unknown, macroName: string): boolean {
  if (macros === null || typeof macros !== 'object') return false;
  const lower = macroName.toLowerCase();
  return Object.keys(macros).some(k => k.toLowerCase() === lower);
}

/**
 * Build an edit adding `macroName` under the `macros` mapping of a YAML config.
 * When `macros` is a non-empty block mapping, the entry is inserted right after
 * its last item, matching its indentation and leaving the rest of the file
 * untouched. Otherwise the document is updated through the YAML library and
 * only the changed span is replaced. Returns null when the config is not valid
 * YAML, is not a mapping, or already defines the macro.
 */
function addMacroToYamlConfig(text: string, macroName: string): TextEdit | null {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return null;
  if (doc.contents !== null && !isMap(doc.contents)) return null;

  const path = macrosPath(doc.toJS());
  const parent = path.length > 1 ? doc.getIn(path.slice(0, -1), true) : doc.contents;
  const macros = doc.getIn(path, true);
  if (isMap(macros) && definesMacro(macros.toJS(doc), macroName)) return null;

  if (isMap(parent) && isMap(macros) && !macros.flow && macros.items.length > 0 && macros.range) {
    const macrosKey = parent.items.find(p => isScalar(p.key) && p.key.value === 'macros')?.key;
    const firstKey = macros.items[0].key;
    if (isScalar(macrosKey) && macrosKey.range && isScalar(firstKey) && firstKey.range) {
      const indent = columnOf(text, firstKey.range[0]);
      const step = Math.max(indent - columnOf(text, macrosKey.range[0]), 1);
      const entry = stringifyYaml({ [macroName]: NEW_MACRO_ENTRY }, { indent: step })
        .replace(/^(?=.)/gm, ' '.repeat(indent));

      // Insert at the start of the line following the end of the last item
      let offset = macros.range[1];
      if (offset > 0 && text[offset - 1] !== '\n') {
        const nl = text.indexOf('\n', offset);
        offset = nl === -1 ? text.length : nl + 1;
      }
      const lead = offset === text.length && text.length > 0 && !text.endsWith('\n') ? '\n' : '';
      const pos = offsetToPosition(text, offset);
      return { range: { start: pos, end: pos }, newText: lead + entry };
    }
  }

  if (isMap(macros)) {
    macros.set(macroName, doc.createNode(NEW_MACRO_ENTRY));
  } else {
    doc.setIn(path, doc.createNode({ [macroName]: NEW_MACRO_ENTRY }));
  }
  return minimalEdit(text, doc.toString({ lineWidth: 0 }));
}

/**
 * Build an edit adding `macroName` under the `macros` object of a JSON config,
 * keeping the file's indentation. Returns null when the config is not a valid
 * JSON object or already defines the macro.
 */
function addMacroToJsonConfig(text: string, macroName: string): TextEdit | null {
  let raw: unknown;
  try {
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const path = macrosPath(raw);
  const container = path.length > 1
    ? (raw as Record<string, Record<string, unknown>>)[path[0]]
    : raw as Record<string, unknown>;
  const macros = container.macros;
  if (definesMacro(macros, macroName)) return null;

  if (macros !== null && typeof macros === 'object' && !Array.isArray(macros)) {
    (macros as Record<string, unknown>)[macroName] = NEW_MACRO_ENTRY;
  } else {
    container.macros = { [macroName]: NEW_MACRO_ENTRY };
  }

  const indent = text.match(/^[ \t]+(?=")/m)?.[0] ?? '  ';
  const newline = text.endsWith('\n') || !text.trim() ? '\n' : '';
  return minimalEdit(text, JSON.stringify(raw, null, indent) + newline);
}

/** Zero-based column of `offset` within its line. */
function columnOf(text: string, offset: number): number {
  return offset - (text.lastIndexOf('\n', offset - 1) + 1);
}

function offsetToPosition(text: string, offset: number): Position {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  return { line: before.split('\n').length - 1, character: offset - lineStart };
}

/** A single edit turning `oldText` into `newText` that spans only the differing region. */
function minimalEdit(oldText: string, newText: string): TextEdit {
  const max = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < max && oldText[prefix] === newText[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < max - prefix
    && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) suffix++;

  return {
    range: {
      start: offsetToPosition(oldText, prefix),
      end: offsetToPosition(oldText, oldText.length - suffix),
    },
    newText: newText.slice(prefix, newText.length - suffix),
  };
}

/**
 * Insert `body` (one or more complete lines, `\n`-terminated) at line index
 * `line`. When `line` lies past the last line (EOF), the edit targets the real
 * end of the text and a separator is prepended unless EOF is already at a line
 * boundary. Line endings follow the document (CRLF aware).
 */
function insertLinesAt(text: string, line: number, body: string): { range: Range; newText: string } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split('\n');
  const normalized = body.replace(/\r?\n/g, eol);
  if (line < lines.length) {
    const pos = { line, character: 0 };
    return { range: { start: pos, end: pos }, newText: normalized };
  }
  const end = offsetToPosition(text, text.length);
  const atBoundary = text.length === 0 || text.endsWith('\n');
  return { range: { start: end, end }, newText: (atBoundary ? '' : eol) + normalized };
}

/** Line index where the declaration passage content ends (or `lines.length`). */
function declarationInsertEdit(
  text: string,
  headerLine: number,
  declaration: string,
): { range: Range; newText: string } {
  const lines = text.split('\n');
  let contentEnd = lines.length;
  for (let i = headerLine + 1; i < lines.length; i++) {
    if (/^::\s+/.test(lines[i])) {
      contentEnd = i;
      break;
    }
  }
  // A trailing newline yields an empty final "line" that is not content.
  if (contentEnd === lines.length && text.endsWith('\n')) contentEnd = lines.length;
  return insertLinesAt(text, contentEnd, declaration);
}

// ---------------------------------------------------------------------------
// Quick fix: SP200 — Declare variable in StoryVariables
// ---------------------------------------------------------------------------

function fixUndeclaredVariable(
  diag: Diagnostic,
  workspace: WorkspaceModel,
): CodeAction | null {
  // Extract variable name from message: "Variable '$varName' is not declared in StoryVariables"
  const match = diag.message.match(/'\$(\w+)'/);
  if (!match) return null;

  const varName = match[1];

  const storyVars = workspace.passages.getStoryVariables();
  if (!storyVars) return null;

  const storyVarsUri = storyVars.uri;
  const text = workspace.documents.getText(storyVarsUri);
  if (text === undefined) return null;

  const edit = declarationInsertEdit(text, storyVars.headerEnd.end.line, `$${varName} = 0\n`);

  return {
    title: `Declare '$${varName}' in StoryVariables`,
    kind: 'quickfix',
    diagnosticCodes: [DiagnosticCode.UndeclaredVariable],
    edits: [{ uri: storyVarsUri, ...edit }],
  };
}

// ---------------------------------------------------------------------------
// Quick fix: SP202 — Create StoryVariables passage
// ---------------------------------------------------------------------------

function fixNoStoryVariables(
  workspace: WorkspaceModel,
): CodeAction | null {
  // Same owner as the SP202 diagnostic, so applying the fix clears it.
  const targetUri = missingStoryVariablesOwner(workspace);
  if (targetUri === undefined) return null;

  const text = workspace.documents.getText(targetUri);
  if (text === undefined) return null;

  const edit = insertLinesAt(text, text.split('\n').length, '\n:: StoryVariables\n');

  return {
    title: 'Create StoryVariables passage',
    kind: 'quickfix',
    diagnosticCodes: [DiagnosticCode.NoStoryVariables],
    edits: [{ uri: targetUri, ...edit }],
  };
}

// ---------------------------------------------------------------------------
// Quick fix: SP203 — Declare transient variable in StoryTransients
// ---------------------------------------------------------------------------

function fixUndeclaredTransient(
  diag: Diagnostic,
  workspace: WorkspaceModel,
): CodeAction | null {
  const match = diag.message.match(/'%(\w+)'/);
  if (!match) return null;

  const varName = match[1];

  const storyTransients = workspace.passages.getStoryTransients();
  if (!storyTransients) return null;

  const storyTransientsUri = storyTransients.uri;
  const text = workspace.documents.getText(storyTransientsUri);
  if (text === undefined) return null;

  const edit = declarationInsertEdit(text, storyTransients.headerEnd.end.line, `%${varName} = 0\n`);

  return {
    title: `Declare '%${varName}' in StoryTransients`,
    kind: 'quickfix',
    diagnosticCodes: [DiagnosticCode.UndeclaredTransient],
    edits: [{ uri: storyTransientsUri, ...edit }],
  };
}

// ---------------------------------------------------------------------------
// Quick fix: SP204 — Replace null with valid default
// ---------------------------------------------------------------------------

function fixNullVariableValue(uri: string, diag: Diagnostic): CodeAction | null {
  // The diagnostic range covers the "null" token
  return {
    title: 'Replace null with 0',
    kind: 'quickfix',
    diagnosticCodes: [DiagnosticCode.NullVariableValue],
    edits: [{
      uri,
      range: diag.range,
      newText: '0',
    }],
  };
}

// ---------------------------------------------------------------------------
// Quick fix: SP103 — Rewrite {if} or {print} in an attribute as an expression
// ---------------------------------------------------------------------------

/**
 * Spindle evaluates `{C ? 'A' : 'B'}` and `{E}` in an attribute value where
 * it outputs `{if C}A{else}B{/if}` and `{print E}` as text.
 * conditionalExpression() and printExpression() decide when the rewrite is
 * safe; the diagnostic range covers the whole construct.
 */
function fixAttributeMacro(uri: string, diag: Diagnostic, workspace: WorkspaceModel): CodeAction | null {
  const text = workspace.documents.getText(uri);
  if (text === undefined) return null;
  const lineStarts = buildLineStarts(text);
  const offset = (p: Position) => (lineStarts[p.line] ?? text.length) + p.character;
  const source = text.slice(offset(diag.range.start), offset(diag.range.end));
  const expression = conditionalExpression(source) ?? printExpression(source);
  if (!expression) return null;
  return {
    title: `Rewrite as ${expression}`,
    kind: 'quickfix',
    diagnosticCodes: [DiagnosticCode.UnevaluatedAttributeBlock],
    edits: [{ uri, range: diag.range, newText: expression }],
  };
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

export const codeActionsPlugin: SpindlePlugin = {
  id: 'code-actions',
  capabilities: {
    codeActionProvider: {
      codeActionKinds: ['quickfix'],
    },
  },
  initialize(ctx: PluginContext) {
    ctx.connection.onCodeAction((params) => {
      // Convert LSP diagnostics back to our Diagnostic type
      const diagnostics: Diagnostic[] = params.context.diagnostics
        .filter(d => d.source === 'spindle')
        .map(d => ({
          range: {
            start: { line: d.range.start.line, character: d.range.start.character },
            end: { line: d.range.end.line, character: d.range.end.character },
          },
          message: d.message,
          severity: d.severity === 1 ? 'error' as const
            : d.severity === 2 ? 'warning' as const
            : d.severity === 3 ? 'info' as const
            : 'hint' as const,
          code: String(d.code ?? ''),
          source: d.source ?? 'spindle',
        }));

      const actions = computeCodeActions(
        params.textDocument.uri,
        diagnostics,
        ctx.workspace,
        { workspaceRoot: ctx.config.workspaceRoot },
      );

      return actions.map(a => ({
        title: a.title,
        kind: a.kind,
        diagnostics: params.context.diagnostics.filter(d =>
          a.diagnosticCodes.includes(String(d.code)),
        ),
        edit: a.createFile
          ? {
            // Resource operations are only expressible via documentChanges
            documentChanges: [
              { kind: 'create' as const, uri: a.createFile, options: { ignoreIfExists: true } },
              ...a.edits.map(e => ({
                textDocument: { uri: e.uri, version: null },
                edits: [{ range: toLspRange(e.range), newText: e.newText }],
              })),
            ],
          }
          : {
            changes: Object.fromEntries(
              a.edits.map(e => [
                e.uri,
                [{ range: toLspRange(e.range), newText: e.newText }],
              ]),
            ),
          },
      }));
    });
  },
};
