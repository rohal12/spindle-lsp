/**
 * Review contract corpus. These assertions describe desired behavior, rather
 * than blessing known failures. See docs/reviews/process.md for triage/closure.
 * Runtime evaluation below is restricted to literals constructed by these tests.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { tokenize } from '../../node_modules/@rohal12/spindle/src/markup/tokenizer.js';
import { parseStoryVariables } from '../../node_modules/@rohal12/spindle/src/story-variables.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import type { Range } from '../../src/core/types.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { computeRename } from '../../src/plugins/rename.js';
import { findPassageReferences, findVariableReferences, findWidgetReferences } from '../../src/plugins/references.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { computeDocumentLinks } from '../../src/plugins/document-link.js';
import { computeCodeLenses } from '../../src/plugins/code-lens.js';
import { computeCodeActions } from '../../src/plugins/code-actions.js';
import { getCompletions } from '../../src/plugins/completions.js';
import { getSignatureHelp } from '../../src/plugins/signature.js';
import { computeSemanticTokensAbsolute } from '../../src/plugins/semantic-tokens.js';
import { formatDocument } from '../../src/plugins/format.js';

const uri = 'file:///story.tw';
const models: WorkspaceModel[] = [];
function workspace(text: string, extra: Array<[string, string]> = []) {
  const model = new WorkspaceModel({ workspaceRoot: process.cwd() });
  model.initialize(new Map([...extra, [uri, text]]));
  models.push(model);
  return model;
}
afterEach(() => { for (const model of models.splice(0)) model.dispose(); });

function apply(text: string, edits: Array<{ range: Range; newText: string }>) {
  return TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, text), edits);
}
function renamed(model: WorkspaceModel, line: number, character: number, name: string) {
  const edits = computeRename(uri, { line, character }, name, model);
  return apply(model.documents.getText(uri)!, edits.get(uri) ?? []);
}
function codes(model: WorkspaceModel) {
  return computeDiagnostics(uri, model).map(d => d.code);
}
function runtimeMacroArgs(text: string) {
  return tokenize(text).filter(t => t.type === 'macro').map(t => t.rawArgs);
}

