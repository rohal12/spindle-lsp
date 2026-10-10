import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument, isMap, isScalar, stringify as stringifyYaml } from 'yaml';
import type { Position, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { DiagnosticCode, type SpindleDiagnostic } from '../core/diagnostic-codes.js';
import { findConfigFile } from '../core/workspace/config-loader.js';
import { missingStoryVariablesOwner } from '../core/workspace/story-variables-owner.js';
import { isMacroSource } from '../core/workspace/macro-sources.js';
import { buildLineStarts, positionToOffset } from '../core/text.js';

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
 * Compute quick-fix code actions for the given diagnostics. What a fix needs
 * to know travels in the diagnostic's `data` (see `DiagnosticData`).
 *
 * Supported fixes:
 *  - SP100 (unknown macro) -> "Change to '{suggestion}'", "Add 'macroName' to <project config>"
 *  - SP101, SP102 (unclosed block or element) -> "Insert {/name}" at the end of the passage
 *  - SP113 (`{goto Kitchen}`) -> "Quote the passage name"
 *  - SP200 (undeclared variable) -> "Declare '$varName' in StoryVariables"
 *  - SP202 (no StoryVariables) -> "Create StoryVariables passage"
 *  - SP203 (undeclared transient) -> "Declare '%varName' in StoryTransients"
 *  - SP300 (broken link) -> "Change to '{suggestion}'", "Create passage 'Name'"
 */
export function computeCodeActions(
  uri: string,
  diagnostics: SpindleDiagnostic[],
  workspace: WorkspaceModel,
  options: CodeActionOptions = {},
): CodeAction[] {
  const actions: CodeAction[] = [];

  for (const diag of diagnostics) {
    switch (diag.code) {
      case DiagnosticCode.UndefinedMacro:
        actions.push(...fixUndefinedMacro(uri, diag, workspace, options));
        break;
      case DiagnosticCode.MalformedContainer:
      case DiagnosticCode.MalformedElement:
        actions.push(...fixUnclosedBlock(uri, diag));
        break;
      case DiagnosticCode.UnquotedPassageName:
        actions.push(...fixUnquotedPassageName(uri, diag));
        break;
      case DiagnosticCode.UndeclaredVariable:
        actions.push(...fixUndeclaredVariable(diag, workspace));
        break;
      case DiagnosticCode.NoStoryVariables: {
        const action = fixNoStoryVariables(workspace);
        if (action) actions.push(action);
        break;
      }
      case DiagnosticCode.UndeclaredTransient:
        actions.push(...fixUndeclaredTransient(diag, workspace));
        break;
      case DiagnosticCode.BrokenPassageLink:
        actions.push(...fixBrokenLink(uri, diag, workspace));
        break;
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
  diag: SpindleDiagnostic,
  workspace: WorkspaceModel,
  options: CodeActionOptions,
): CodeAction[] {
  const data = diag.data;
  if (data?.kind !== 'unknown-macro') return [];
  const actions: CodeAction[] = data.suggestions.map(suggestion => ({
    title: `Change to '{${suggestion}}'`,
    kind: 'quickfix',
    diagnosticCodes: [DiagnosticCode.UndefinedMacro],
    edits: [{ uri, range: data.nameRange, newText: suggestion }],
  }));
  const config = addMacroToConfig(uri, data.name, workspace, options);
  if (config) actions.push(config);
  return actions;
}

function addMacroToConfig(
  uri: string,
  macroName: string,
  workspace: WorkspaceModel,
  options: CodeActionOptions,
): CodeAction | null {
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
 * boundary. `eol` is the line ending to write (see {@link lineEndingFor}).
 */
function insertLinesAt(text: string, line: number, body: string, eol: string): { range: Range; newText: string } {
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

/**
 * The line ending to write into document `uri`: its own when it has a line
 * break (CRLF if it uses any), otherwise (empty or header-only, nothing to
 * detect) that of the first other story document that has one, otherwise LF.
 */
function lineEndingFor(workspace: WorkspaceModel, uri: string): string {
  const own = workspace.documents.getText(uri) ?? '';
  const detect = (text: string) => (text.includes('\r\n') ? '\r\n' : text.includes('\n') ? '\n' : undefined);
  const fromOwn = detect(own);
  if (fromOwn) return fromOwn;
  for (const other of workspace.documents.getUris()) {
    if (other === uri || isMacroSource(other)) continue;
    const found = detect(workspace.documents.getText(other) ?? '');
    if (found) return found;
  }
  return '\n';
}

/** Line index where the declaration passage content ends (or `lines.length`). */
function declarationInsertEdit(
  text: string,
  headerLine: number,
  declaration: string,
  eol: string,
): { range: Range; newText: string } {
  const lines = text.split('\n');
  let contentEnd = lines.length;
  for (let i = headerLine + 1; i < lines.length; i++) {
    if (/^\uFEFF?::\s+/.test(lines[i])) {
      contentEnd = i;
      break;
    }
  }
  // A trailing newline yields an empty final "line" that is not content.
  if (contentEnd === lines.length && text.endsWith('\n')) contentEnd = lines.length;
  return insertLinesAt(text, contentEnd, declaration, eol);
}

// ---------------------------------------------------------------------------
// Quick fix: SP200, SP203 — Declare a variable in StoryVariables or StoryTransients
// ---------------------------------------------------------------------------

function declareVariable(diag: SpindleDiagnostic, workspace: WorkspaceModel, sigil: '$' | '%'): CodeAction[] {
  if (diag.data?.kind !== 'undeclared-variable' || diag.data.sigil !== sigil) return [];
  const { name } = diag.data;

  const passage = sigil === '$' ? workspace.passages.getStoryVariables() : workspace.passages.getStoryTransients();
  if (!passage) return [];
  const text = workspace.documents.getText(passage.uri);
  if (text === undefined) return [];

  const edit = declarationInsertEdit(text, passage.headerEnd.end.line, `${sigil}${name} = 0\n`, lineEndingFor(workspace, passage.uri));
  return [{
    title: `Declare '${sigil}${name}' in ${sigil === '$' ? 'StoryVariables' : 'StoryTransients'}`,
    kind: 'quickfix',
    diagnosticCodes: [sigil === '$' ? DiagnosticCode.UndeclaredVariable : DiagnosticCode.UndeclaredTransient],
    edits: [{ uri: passage.uri, ...edit }],
  }];
}

const fixUndeclaredVariable = (diag: SpindleDiagnostic, workspace: WorkspaceModel) => declareVariable(diag, workspace, '$');
const fixUndeclaredTransient = (diag: SpindleDiagnostic, workspace: WorkspaceModel) => declareVariable(diag, workspace, '%');

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

  const edit = insertLinesAt(text, text.split('\n').length, '\n:: StoryVariables\n', lineEndingFor(workspace, targetUri));

  return {
    title: 'Create StoryVariables passage',
    kind: 'quickfix',
    diagnosticCodes: [DiagnosticCode.NoStoryVariables],
    edits: [{ uri: targetUri, ...edit }],
  };
}

// ---------------------------------------------------------------------------
// Quick fix: SP101, SP102 — Close an unclosed block or element
// ---------------------------------------------------------------------------

/** Insert the missing closing tag where the passage ends. */
function fixUnclosedBlock(uri: string, diag: SpindleDiagnostic): CodeAction[] {
  if (diag.data?.kind !== 'unclosed-block') return [];
  const { closer, at } = diag.data;
  return [{
    title: `Insert ${closer}`,
    kind: 'quickfix',
    diagnosticCodes: [diag.code],
    edits: [{ uri, range: { start: at, end: at }, newText: closer }],
  }];
}

// ---------------------------------------------------------------------------
// Quick fix: SP113 — Quote a passage name
// ---------------------------------------------------------------------------

/** `{goto Kitchen}` is an expression, and throws a ReferenceError: the name is a quoted string. */
function fixUnquotedPassageName(uri: string, diag: SpindleDiagnostic): CodeAction[] {
  if (diag.data?.kind !== 'unquoted-passage-name') return [];
  return [{
    title: `Quote the passage name: ${JSON.stringify(diag.data.name)}`,
    kind: 'quickfix',
    diagnosticCodes: [DiagnosticCode.UnquotedPassageName],
    edits: [{ uri, range: diag.range, newText: JSON.stringify(diag.data.name) }],
  }];
}

// ---------------------------------------------------------------------------
// Quick fix: SP300 — Change a broken link to a close passage, or create the passage
// ---------------------------------------------------------------------------

function fixBrokenLink(uri: string, diag: SpindleDiagnostic, workspace: WorkspaceModel): CodeAction[] {
  if (diag.data?.kind !== 'unknown-passage') return [];
  const { name, suggestions } = diag.data;
  const text = workspace.documents.getText(uri);
  if (text === undefined) return [];
  const actions: CodeAction[] = [];

  // The name is written as a quoted string, or as it is (a bracket link, the body of {dialog})
  const lineStarts = buildLineStarts(text);
  const written = text.slice(positionToOffset(diag.range.start, lineStarts), positionToOffset(diag.range.end, lineStarts));
  const quote = written[0] === '"' || written[0] === "'" ? written[0] : undefined;
  for (const suggestion of suggestions) {
    const spelled = quote ? spellQuoted(suggestion, quote) : spellBare(suggestion);
    if (spelled === undefined) continue;
    actions.push({
      title: `Change to '${suggestion}'`,
      kind: 'quickfix',
      diagnosticCodes: [DiagnosticCode.BrokenPassageLink],
      edits: [{ uri, range: diag.range, newText: spelled }],
    });
  }

  // A new passage after the last one of the document
  const header = `:: ${name.replace(/[\\[\]{}]/g, '\\$&')}`;
  if (name.trim() === name && name !== '' && !/[\r\n]/.test(name)) {
    const edit = insertLinesAt(text, text.split('\n').length, `\n${header}\n`, lineEndingFor(workspace, uri));
    actions.push({
      title: `Create passage '${name}'`,
      kind: 'quickfix',
      diagnosticCodes: [DiagnosticCode.BrokenPassageLink],
      edits: [{ uri, ...edit }],
    });
  }
  return actions;
}

/** `name` as a string literal with `quote`, or undefined if it cannot be written on a line. */
function spellQuoted(name: string, quote: string): string | undefined {
  if (/[\r\n]/.test(name)) return undefined;
  return quote + name.replace(/[\\"']/g, (ch) => (ch === '\\' || ch === quote ? `\\${ch}` : ch)) + quote;
}

/** `name` as the target of a bracket link, or undefined if the link syntax would read it differently. */
function spellBare(name: string): string | undefined {
  return /[\r\n|\]]|->|<-/.test(name) ? undefined : name;
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
      const diagnostics: SpindleDiagnostic[] = params.context.diagnostics
        .filter(d => d.source === 'spindle')
        .map(d => ({
          range: {
            start: { line: d.range.start.line, character: d.range.start.character },
            end: { line: d.range.end.line, character: d.range.end.character },
          },
          // LSP 3.18 lets a message be markup; our diagnostics are always plain text
          message: typeof d.message === 'string' ? d.message : d.message.value,
          severity: d.severity === 1 ? 'error' as const
            : d.severity === 2 ? 'warning' as const
            : d.severity === 3 ? 'info' as const
            : 'hint' as const,
          code: String(d.code ?? ''),
          source: d.source ?? 'spindle',
          data: d.data as SpindleDiagnostic['data'],
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
