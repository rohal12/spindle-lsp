import type { Diagnostic, Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { DiagnosticCode } from '../core/diagnostic-codes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeAction {
  title: string;
  kind: string;
  diagnosticCodes: string[];
  edits: Array<{ uri: string; range: Range; newText: string }>;
}

// ---------------------------------------------------------------------------
// Core code actions function (no LSP dependency)
// ---------------------------------------------------------------------------

/**
 * Compute quick-fix code actions for the given diagnostics.
 *
 * Supported fixes:
 *  - SP100 (undefined macro) -> "Add 'macroName' to spindle.config.yaml"
 *  - SP200 (undeclared variable) -> "Declare '$varName' in StoryVariables"
 *  - SP202 (no StoryVariables) -> "Create StoryVariables passage"
 *  - SP203 (undeclared transient) -> "Declare '%varName' in StoryTransients"
 */
export function computeCodeActions(
  uri: string,
  diagnostics: Diagnostic[],
  workspace: WorkspaceModel,
): CodeAction[] {
  const actions: CodeAction[] = [];

  for (const diag of diagnostics) {
    switch (diag.code) {
      case DiagnosticCode.UndefinedMacro: {
        const action = fixUndefinedMacro(diag);
        if (action) actions.push(action);
        break;
      }
      case DiagnosticCode.UndeclaredVariable: {
        const action = fixUndeclaredVariable(diag, workspace);
        if (action) actions.push(action);
        break;
      }
      case DiagnosticCode.NoStoryVariables: {
        const action = fixNoStoryVariables(uri, workspace);
        if (action) actions.push(action);
        break;
      }
      case DiagnosticCode.UndeclaredTransient: {
        const action = fixUndeclaredTransient(diag, workspace);
        if (action) actions.push(action);
        break;
      }
      // No quick fix for other diagnostic codes
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Quick fix: SP100 — Add macro to spindle.config.yaml
// ---------------------------------------------------------------------------

function fixUndefinedMacro(diag: Diagnostic): CodeAction | null {
  // Extract macro name from message: "Unrecognized macro: {macroName}"
  const match = diag.message.match(/\{(\w[\w-]*)\}/);
  if (!match) return null;

  const macroName = match[1];
  const configUri = 'file:///spindle.config.yaml';

  // Generate YAML snippet to append
  const yamlSnippet = `\n  ${macroName}:\n    description: ""\n`;

  return {
    title: `Add '${macroName}' to spindle.config.yaml`,
    kind: 'quickfix',
    diagnosticCodes: [DiagnosticCode.UndefinedMacro],
    edits: [{
      uri: configUri,
      range: {
        start: { line: Number.MAX_SAFE_INTEGER, character: 0 },
        end: { line: Number.MAX_SAFE_INTEGER, character: 0 },
      },
      newText: yamlSnippet,
    }],
  };
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

  // Find the end of the StoryVariables passage content
  const lines = text.split('\n');
  const contentStart = storyVars.headerEnd.end.line + 1;
  let contentEnd = lines.length;
  for (let i = contentStart; i < lines.length; i++) {
    if (/^::\s+/.test(lines[i])) {
      contentEnd = i;
      break;
    }
  }

  // Insert at the end of StoryVariables content
  const insertLine = contentEnd;

  return {
    title: `Declare '$${varName}' in StoryVariables`,
    kind: 'quickfix',
    diagnosticCodes: [DiagnosticCode.UndeclaredVariable],
    edits: [{
      uri: storyVarsUri,
      range: {
        start: { line: insertLine, character: 0 },
        end: { line: insertLine, character: 0 },
      },
      newText: `$${varName} = null\n`,
    }],
  };
}

// ---------------------------------------------------------------------------
// Quick fix: SP202 — Create StoryVariables passage
// ---------------------------------------------------------------------------

function fixNoStoryVariables(
  uri: string,
  workspace: WorkspaceModel,
): CodeAction | null {
  // Find the first document in the workspace to append the passage
  const uris = workspace.documents.getUris();
  const targetUri = uris.length > 0 ? uris[0] : uri;

  const text = workspace.documents.getText(targetUri);
  if (text === undefined) return null;

  const lines = text.split('\n');
  const lastLine = lines.length;

  return {
    title: 'Create StoryVariables passage',
    kind: 'quickfix',
    diagnosticCodes: [DiagnosticCode.NoStoryVariables],
    edits: [{
      uri: targetUri,
      range: {
        start: { line: lastLine, character: 0 },
        end: { line: lastLine, character: 0 },
      },
      newText: '\n:: StoryVariables\n',
    }],
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

  const lines = text.split('\n');
  const contentStart = storyTransients.headerEnd.end.line + 1;
  let contentEnd = lines.length;
  for (let i = contentStart; i < lines.length; i++) {
    if (/^::\s+/.test(lines[i])) {
      contentEnd = i;
      break;
    }
  }

  const insertLine = contentEnd;

  return {
    title: `Declare '%${varName}' in StoryTransients`,
    kind: 'quickfix',
    diagnosticCodes: [DiagnosticCode.UndeclaredTransient],
    edits: [{
      uri: storyTransientsUri,
      range: {
        start: { line: insertLine, character: 0 },
        end: { line: insertLine, character: 0 },
      },
      newText: `%${varName} = null\n`,
    }],
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
      );

      return actions.map(a => ({
        title: a.title,
        kind: a.kind,
        diagnostics: params.context.diagnostics.filter(d =>
          a.diagnosticCodes.includes(String(d.code)),
        ),
        edit: {
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
