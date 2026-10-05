/**
 * Cell bookkeeping and cross-consumer sweeps for the review corpus.
 * A cell is one named (role, context, spelling, boundary, state, consumer)
 * selection. Its status is pass / fail / not-run / not-applicable and is
 * written to docs/reviews/2026-10-06-cross-consumer-results.json.
 */
import { TextDocument } from 'vscode-languageserver-textdocument';
import { expect } from 'vitest';
import { WorkspaceModel } from '../../../src/core/workspace/workspace-model.js';
import type { Position, Range } from '../../../src/core/types.js';
import { computeDiagnostics } from '../../../src/plugins/diagnostics.js';
import { findReferences, type ReferenceLocation } from '../../../src/plugins/references.js';
import { getDefinition } from '../../../src/plugins/definition.js';
import { prepareRename } from '../../../src/plugins/rename.js';
import { computeDocumentLinks } from '../../../src/plugins/document-link.js';
import { computeCodeLenses } from '../../../src/plugins/code-lens.js';
import { computeSemanticTokensAbsolute } from '../../../src/plugins/semantic-tokens.js';

export type CellStatus = 'pass' | 'fail' | 'not-run' | 'not-applicable';
export interface Dims {
  role: string;
  context: string;
  spelling: string;
  boundary: string;
  state: string;
  consumer: string;
}
export interface CellRecord extends Dims { id: string; status: CellStatus; note?: string }

export class NotApplicable extends Error {}
export function notApplicable(reason: string): never { throw new NotApplicable(reason); }

export const records: CellRecord[] = [];

export const root = process.cwd();
export type Files = Record<string, string>;
export const U = (name: string) => `file:///${name}`;

const live: WorkspaceModel[] = [];
export function build(files: Files, order: string[] = Object.keys(files)): WorkspaceModel {
  const model = new WorkspaceModel({ workspaceRoot: root });
  model.initialize(new Map(order.map(n => [U(n), files[n]] as [string, string])));
  live.push(model);
  return model;
}
export function disposeAll() { for (const m of live.splice(0)) m.dispose(); }

export function texts(model: WorkspaceModel): Files {
  const out: Files = {};
  for (const uri of model.documents.getUris()) out[uri.replace('file:///', '')] = model.documents.getText(uri)!;
  return out;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export function doc(text: string) { return TextDocument.create('file:///x', 'twee', 0, text); }

/** Every cursor offset of `text`: UTF-16, never inside a surrogate pair or a CRLF. */
export function cursorOffsets(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i <= text.length; i++) {
    const c = text.charCodeAt(i);
    const prev = text.charCodeAt(i - 1);
    if (i > 0 && prev >= 0xd800 && prev <= 0xdbff && c >= 0xdc00 && c <= 0xdfff) continue;
    if (i > 0 && prev === 13 && c === 10) continue;
    out.push(i);
  }
  return out;
}

export function rangeProblem(text: string, r: Range): string | null {
  const d = doc(text);
  const lines = text.split(/\r\n|\n|\r/);
  for (const p of [r.start, r.end]) {
    if (!Number.isInteger(p.line) || !Number.isInteger(p.character) || p.line < 0 || p.character < 0) return `bad position ${JSON.stringify(p)}`;
    if (p.line >= lines.length) return `line ${p.line} beyond ${lines.length} lines`;
    const line = lines[p.line];
    if (p.character > line.length) return `character ${p.character} beyond line ${p.line} length ${line.length}`;
    const hi = line.charCodeAt(p.character - 1), lo = line.charCodeAt(p.character);
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) return `position ${p.line}:${p.character} splits a surrogate pair`;
  }
  if (d.offsetAt(r.start) > d.offsetAt(r.end)) return 'start after end';
  return null;
}

export const spanKey = (r: ReferenceLocation) => `${r.uri.replace('file:///', '')}@${r.range.start.line}:${r.range.start.character}-${r.range.end.line}:${r.range.end.character}`;
const rangeKey = (r: Range) => `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`;

// ---------------------------------------------------------------------------
// The per-position sweep over the navigation consumers
// ---------------------------------------------------------------------------

export interface Probe {
  uri: string;
  offset: number;
  pos: Position;
  refs: ReferenceLocation[];      // includeDeclaration false
  refsDecl: ReferenceLocation[];  // includeDeclaration true
  def: { uri: string; range: Range } | null;
  prep: { range: Range; placeholder: string } | null;
}

export function sweep(model: WorkspaceModel, uri: string): Probe[] {
  const text = model.documents.getText(uri)!;
  const d = doc(text);
  return cursorOffsets(text).map(offset => {
    const pos = d.positionAt(offset);
    return {
      uri, offset, pos,
      refs: findReferences(uri, pos, model, false),
      refsDecl: findReferences(uri, pos, model, true),
      def: getDefinition(uri, pos, model),
      prep: prepareRename(uri, pos, model),
    };
  });
}

/** Everything the read-only consumers say about a workspace, for state differentials. */
export function snapshot(model: WorkspaceModel): unknown {
  const out: Record<string, unknown> = {};
  for (const uri of model.documents.getUris().sort()) {
    out[uri] = {
      diagnostics: computeDiagnostics(uri, model),
      links: computeDocumentLinks(uri, model),
      lenses: computeCodeLenses(uri, model),
      tokens: computeSemanticTokensAbsolute(uri, model),
      sweep: sweep(model, uri).map(p => [p.offset, p.refs.map(spanKey), p.refsDecl.map(spanKey), p.def, p.prep]),
    };
  }
  return out;
}

export const norm = (r: Range) => rangeKey(r);
export function expectProblemFree(label: string, text: string, r: Range) {
  const problem = rangeProblem(text, r);
  expect(problem, `${label}: ${JSON.stringify(r)}`).toBeNull();
}
