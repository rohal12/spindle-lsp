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

// Models are expensive to build and the properties of one scene all read the
// same workspace, so `build` shares read-only models between them (a small LRU,
// so a long scene list never holds more than a few). A property that mutates a
// model (open/update/close) must take its own with `buildFresh`: the state
// differentials compare histories, so they never share.
const live: WorkspaceModel[] = [];
const shared = new Map<string, WorkspaceModel>();
const SHARED_LIMIT = 24;

/**
 * Every range a consumer returns is in the client's coordinates, so the model
 * must hold each document exactly as the client sent it (a leading BOM, CRLF
 * and all). A model that quietly holds a normalized copy would make every
 * bounds and offset check below agree with itself while the client's own
 * buffer disagrees.
 */
export function assertClientBasis(model: WorkspaceModel, files: Files, names: string[] = Object.keys(files)): void {
  for (const n of names) {
    expect(model.documents.getText(U(n)), `the model holds ${n} as the client sent it`).toBe(files[n]);
  }
}

function make(files: Files, order: string[]): WorkspaceModel {
  const model = new WorkspaceModel({ workspaceRoot: root });
  model.initialize(new Map(order.map(n => [U(n), files[n]] as [string, string])));
  assertClientBasis(model, files, order);
  return model;
}
/** A read-only workspace; the same `files` and `order` give the same model while it is recent. */
export function build(files: Files, order: string[] = Object.keys(files)): WorkspaceModel {
  const key = JSON.stringify([order, order.map(n => files[n])]);
  const hit = shared.get(key);
  if (hit) { shared.delete(key); shared.set(key, hit); return hit; }
  const model = make(files, order);
  shared.set(key, model);
  if (shared.size > SHARED_LIMIT) {
    const [oldKey, oldModel] = shared.entries().next().value as [string, WorkspaceModel];
    shared.delete(oldKey);
    oldModel.dispose();
  }
  return model;
}
/** A workspace of the caller's own, disposed after the test; for properties that change it. */
export function buildFresh(files: Files, order: string[] = Object.keys(files)): WorkspaceModel {
  const model = make(files, order);
  live.push(model);
  return model;
}
export function disposeAll() {
  for (const m of live.splice(0)) m.dispose();
}
/** Release the shared models (end of a test file). */
export function disposeShared() {
  for (const m of shared.values()) m.dispose();
  shared.clear();
}

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

// A sweep depends on the model and the text it holds, so it is kept per model
// and only while the text is unchanged (never across models: two histories that
// reach the same text are exactly what the state differentials compare).
const sweeps = new WeakMap<WorkspaceModel, Map<string, { stamp: string; probes: Probe[] }>>();
/** Every document's text: what a sweep of any one of them can depend on. */
const sweepStamp = (model: WorkspaceModel) => model.documents.getUris().sort().map(u => `${u}\0${model.documents.getText(u)}`).join('\u0001');

export function sweep(model: WorkspaceModel, uri: string): Probe[] {
  const text = model.documents.getText(uri)!;
  let byUri = sweeps.get(model);
  if (!byUri) sweeps.set(model, (byUri = new Map()));
  const kept = byUri.get(uri);
  const stamp = sweepStamp(model);
  if (kept && kept.stamp === stamp) return kept.probes;
  const d = doc(text);
  const probes = cursorOffsets(text).map(offset => {
    const pos = d.positionAt(offset);
    return {
      uri, offset, pos,
      refs: findReferences(uri, pos, model, false),
      refsDecl: findReferences(uri, pos, model, true),
      def: getDefinition(uri, pos, model),
      prep: prepareRename(uri, pos, model),
    };
  });
  byUri.set(uri, { stamp, probes });
  return probes;
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
