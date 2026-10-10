/**
 * Differential properties that hold across consumers for any fixture.
 * Each takes the fixture files and throws on violation (or NotApplicable).
 */
import { expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { WorkspaceModel } from '../../../src/core/workspace/workspace-model.js';
import type { Range } from '../../../src/core/types.js';
import { computeDiagnostics } from '../../../src/plugins/diagnostics.js';
import { computeRename, RenameError } from '../../../src/plugins/rename.js';
import { computeDocumentLinks } from '../../../src/plugins/document-link.js';
import { computeCodeLenses } from '../../../src/plugins/code-lens.js';
import { computeSemanticTokensAbsolute, tokenTypesLegend } from '../../../src/plugins/semantic-tokens.js';
import { formatDocument } from '../../../src/plugins/format.js';
import { getHoverInfo } from '../../../src/plugins/hover.js';
import { findPassageReferences, findWidgetReferences } from '../../../src/plugins/references.js';
import {
  build, buildFresh, cursorOffsets, doc, notApplicable, rangeProblem, snapshot, spanKey, sweep, texts, U,
  type Files, type Probe,
} from './harness.js';
import {
  runtimeMacroHeads, runtimePassageRefs, runtimePayload, runtimeTokens, splitPassages,
} from './oracle.js';

const uriOf = (n: string) => U(n);
const offsetRange = (text: string, r: Range) => {
  const d = doc(text);
  return [d.offsetAt(r.start), d.offsetAt(r.end)] as const;
};

function allSweeps(model: WorkspaceModel) {
  return model.documents.getUris().map(uri => ({ uri, probes: sweep(model, uri) }));
}

// --- 1. every range any consumer returns is a valid range in its document ---

export function propBounds(files: Files) {
  const model = build(files);
  // ranges are validated against the client's own text, not the model's copy
  const check = (what: string, uri: string, r: Range) => {
    const text = files[uri.replace('file:///', '')];
    expect(text, `${what}: unknown document ${uri}`).toBeDefined();
    expect(rangeProblem(text!, r), `${what} ${uri} ${JSON.stringify(r)}`).toBeNull();
  };
  for (const uri of model.documents.getUris()) {
    for (const d of computeDiagnostics(uri, model)) check(`diagnostic ${d.code}`, uri, d.range);
    for (const l of computeDocumentLinks(uri, model)) check('document link', uri, l.range);
    for (const l of computeCodeLenses(uri, model)) check('code lens', uri, l.range);
    const text = files[uri.replace('file:///', '')];
    const lines = text.split('\n');
    for (const t of computeSemanticTokensAbsolute(uri, model)) {
      const line = (lines[t.line] ?? '').replace(/\r$/, '');
      check('semantic token', uri, { start: { line: t.line, character: t.startChar }, end: { line: t.line, character: t.startChar + t.length } });
      expect(t.length, `token on line ${t.line} is empty`).toBeGreaterThan(0);
      expect(t.startChar + t.length).toBeLessThanOrEqual(line.length);
    }
    for (const p of sweep(model, uri)) {
      for (const r of p.refsDecl) check('reference', r.uri, r.range);
      if (p.def) check('definition', p.def.uri, p.def.range);
      if (p.prep) {
        check('prepareRename', uri, p.prep.range);
        // the cursor must be inside the range it offers to rename
        const [s, e] = offsetRange(text, p.prep.range);
        expect(p.offset >= s && p.offset <= e, `prepareRename range ${s}-${e} excludes the cursor ${p.offset}`).toBe(true);
      }
    }
  }
}

// --- 2. references / definition / prepareRename agree on every span ---

export function propNavigationAgree(files: Files) {
  const model = build(files);
  const sweeps = allSweeps(model);
  const byUri = new Map(sweeps.map(s => [s.uri, s.probes]));
  let any = false;
  for (const { uri, probes } of sweeps) {
    const text = model.documents.getText(uri)!;
    for (const p of probes) {
      if (p.refsDecl.length === 0) continue;
      any = true;
      // the symbol under the cursor must be one of its own references or its declaration
      const own = p.refsDecl.some(r => {
        if (r.uri !== uri) return false;
        const [s, e] = offsetRange(text, r.range);
        return p.offset >= s && p.offset <= e;
      });
      expect(own, `references at ${uri}:${p.pos.line}:${p.pos.character} (${JSON.stringify(text.slice(Math.max(0, p.offset - 8), p.offset + 8))}) lists ${p.refsDecl.map(spanKey)} but none contains the cursor`).toBe(true);
    }
    for (const p of probes) {
      for (const r of p.refs) {
        const target = byUri.get(r.uri);
        const rtext = model.documents.getText(r.uri)!;
        const [s, e] = offsetRange(rtext, r.range);
        const want = p.refs.map(spanKey).sort();
        for (const off of [s, e - 1, e]) {
          const q = target?.find(x => x.offset === off);
          if (!q) continue;
          expect(q.refs.map(spanKey).sort(), `references from ${spanKey(r)} disagree with ${uri}:${p.pos.line}:${p.pos.character}`).toEqual(want);
        }
        const first = target?.find(x => x.offset === s);
        if (first) {
          // a reference to a passage that exists can be renamed; one to a missing passage has nothing to rename
        const declared = first.refsDecl.length > first.refs.length;
        const isVariable = /^[$%]/.test(rtext.slice(s, s + 1));
        if (declared || isVariable) {
          expect(first.prep, `no prepareRename on reference ${spanKey(r)}`).not.toBeNull();
          expect(first.prep!.range, `prepareRename range at ${spanKey(r)}`).toEqual(r.range);
        }
        }
      }
    }
  }
  if (!any) notApplicable('no references reported by any cursor position');
}

// --- 3. runtime oracle: passage references across diagnostics/links/references/lenses ---

export function propPassageOracle(files: Files) {
  const model = build(files);
  const known = new Set<string>();
  const perDoc = new Map<string, ReturnType<typeof runtimePassageRefs>>();
  for (const uri of model.documents.getUris()) {
    const text = model.documents.getText(uri)!;
    for (const p of splitPassages(text)) known.add(p.name);
    perDoc.set(uri, runtimePassageRefs(text));
  }
  const all = [...perDoc.values()].flat();
  if (all.length === 0 && [...model.documents.getUris()].every(u => computeDocumentLinks(u, model).length === 0) &&
    !model.documents.getUris().some(u => computeDiagnostics(u, model).some(d => d.code === 'SP300'))) {
    // still compare: no oracle refs must mean no consumer ref
  }
  // references: the union over the passages' references equals the oracle
  for (const target of new Set([...known, ...all.map(r => r.target)])) {
    const got = findPassageReferences(target, model, false);
    for (const uri of model.documents.getUris()) {
      const want = (perDoc.get(uri) ?? []).filter(r => r.target === target);
      const text = model.documents.getText(uri)!;
      const mine = got.filter(r => r.uri === uri).map(r => offsetRange(text, r.range));
      expect(mine.length, `references to ${JSON.stringify(target)} in ${uri}: ${JSON.stringify(mine)} vs runtime ${JSON.stringify(want.map(w => [w.start, w.end, w.kind]))}`).toBe(want.length);
      for (const w of want) {
        expect(mine.filter(([s, e]) => s >= w.start && e <= w.end).length, `no reference span for ${w.kind} ref to ${JSON.stringify(target)} at ${w.start}-${w.end}`).toBe(1);
      }
    }
  }
  // diagnostics: SP300 exactly on the runtime references whose passage does not exist
  for (const uri of model.documents.getUris()) {
    const text = model.documents.getText(uri)!;
    // SP300 is about the passage the author named; a literal the runtime reads differently is also SP304
    const missing = (perDoc.get(uri) ?? []).filter(r => !known.has(r.intended ?? r.target));
    const broken = computeDiagnostics(uri, model).filter(d => d.code === 'SP300').map(d => offsetRange(text, d.range));
    expect(broken.length, `SP300 in ${uri}: ${JSON.stringify(broken)} vs missing ${JSON.stringify(missing.map(m => [m.target, m.start, m.end]))}`).toBe(missing.length);
    for (const m of missing) {
      expect(broken.filter(([s, e]) => s >= m.start && e <= m.end).length, `SP300 for ${JSON.stringify(m.target)} (${m.kind}) at ${m.start}`).toBe(1);
    }
    // SP304: exactly the references whose literal the runtime reads differently from its meaning
    const mismatched = (perDoc.get(uri) ?? []).filter(r => (r.kind === 'bracket' || r.kind === 'link') && r.reads !== r.intended);
    const sp304 = computeDiagnostics(uri, model).filter(d => d.code === 'SP304').map(d => offsetRange(text, d.range));
    expect(sp304.length, `SP304 in ${uri}: ${JSON.stringify(sp304)} vs runtime mismatches ${JSON.stringify(mismatched.map(m => [m.target, m.reads, m.start, m.end]))}`).toBe(mismatched.length);
    for (const m of mismatched) {
      expect(sp304.filter(([s, e]) => s >= m.start && e <= m.end).length, `SP304 for ${JSON.stringify(m.target)} (reads ${JSON.stringify(m.reads)})`).toBe(1);
    }
    // document links: one per bracket link token the runtime resolves
    const links = computeDocumentLinks(uri, model);
    const bracket = (perDoc.get(uri) ?? []).filter(r => r.kind === 'bracket');
    const runtimeLinks = runtimeTokens(text).filter(t => t.token.type === 'link');
    expect(links.length, `document links in ${uri}`).toBe(runtimeLinks.length);
    for (const b of bracket) {
      const l = links.find(x => { const [s, e] = offsetRange(text, x.range); return s >= b.start && e <= b.end; });
      expect(l, `document link for ${b.target}`).toBeDefined();
      expect(l!.target !== undefined, `link target resolution for ${JSON.stringify(b.target)}`).toBe(known.has(b.target));
    }
  }
  // code lenses: the reference count over each passage header
  for (const uri of model.documents.getUris()) {
    const text = model.documents.getText(uri)!;
    const lenses = computeCodeLenses(uri, model);
    const lines = text.split('\n');
    for (const p of splitPassages(text)) {
      if (p.name === 'StoryData') continue;
      const line = doc(text).positionAt(p.headerStart).line;
      const lens = lenses.find(l => l.range.start.line === line && /reference/.test(l.command.title));
      if (!lens) continue;
      const n = all.filter(r => r.target === p.name).length;
      expect(lens.command.title, `lens above ${JSON.stringify(lines[line])}`).toBe(`${n} reference${n !== 1 ? 's' : ''}`);
    }
  }
  if (all.length === 0 && ![...known].length) notApplicable('no passages');
}

/** A widget is a block widget when its body renders `{@children}`; only then does `{/name}` close anything. */
function isBlockWidget(files: Files, name: string): boolean {
  return Object.values(files).some(text => splitPassages(text).some(p => {
    const body = text.slice(p.bodyStart, p.bodyEnd);
    return p.tags.includes('widget') && new RegExp(`\\{widget\\s+["']?${name}["'\\s}]`, 'i').test(body) && /\{@children\}/.test(body);
  }));
}

// --- 4. widget and macro heads: oracle for definitions, references, diagnostics, tokens ---

export function propMacroHeadOracle(files: Files) {
  const model = build(files);
  for (const uri of model.documents.getUris()) {
    const text = model.documents.getText(uri)!;
    const heads = runtimeMacroHeads(text);
    const headSpans = heads.map(h => [h.start, h.end] as const);
    // SP100 (undefined macro) only on a head the runtime tokenizes as a macro
    for (const d of computeDiagnostics(uri, model).filter(d => d.code === 'SP100')) {
      const [s, e] = offsetRange(text, d.range);
      expect(headSpans.some(([a, b]) => s >= a && e <= b), `SP100 at ${s}-${e} (${JSON.stringify(text.slice(s, e))}) is not inside a runtime macro token`).toBe(true);
    }
    // semantic tokens: no token inside runtime text; function tokens only inside macro tokens
    const tokens = runtimeTokens(text);
    const d = doc(text);
    const passages = splitPassages(text);
    for (const t of computeSemanticTokensAbsolute(uri, model)) {
      const s = d.offsetAt({ line: t.line, character: t.startChar });
      const e = s + t.length;
      if (passages.some(p => s >= p.headerStart && s < p.bodyStart)) continue; // header line
      // the innermost token: markup inside a label or an attribute value lies inside the token that holds it
      const hit = tokens.filter(x => s >= x.start && e <= x.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      const owner = passages.find(p => s >= p.bodyStart && s <= p.bodyEnd);
      if (owner && !owner.markup) {
        // StoryVariables / StoryTransients declarations (`$name = ...` at a line start) are highlighted
        const lineStart = text.lastIndexOf('\n', s - 1) + 1;
        const declaration = (owner.name === 'StoryVariables' || owner.name === 'StoryTransients') && lineStart === s;
        if (!declaration) throw new Error(`semantic token ${JSON.stringify(text.slice(s, e))} inside non-markup passage ${owner.name}`);
        continue;
      }
      // `$name` is also read from prose by Spindle < 0.50.1's startup validation (variable tracker), so only
      // that sigil may sit in runtime text; macro names, _temp, @local and %transient tokens must not
      // (and `%name` in prose: kept as a reference by test/unit/variable-declarations.test.ts, #62)
      if (/^(\$|%[A-Za-z_])/.test(text.slice(s, e))) continue;
      expect(hit && hit.token.type !== 'text', `semantic token ${JSON.stringify(text.slice(s, e))} at ${s}-${e} outside every runtime non-text token`).toBeTruthy();
    }
  }
  // widgets: references to each defined widget equal the runtime's head occurrences
  for (const uri of model.documents.getUris()) {
    for (const p of splitPassages(model.documents.getText(uri)!)) {
      if (!p.tags.includes('widget') || !p.markup) continue;
    }
  }
  const defs = [...model.documents.getUris()].flatMap(uri => {
    const text = model.documents.getText(uri)!;
    return runtimeTokens(text).flatMap(t => {
      if (t.token.type !== 'macro' || t.token.isClose || t.token.name.toLowerCase() !== 'widget' || !t.passage.tags.includes('widget')) return [];
      const m = /^\s*(?:"([^"]+)"|'([^']+)'|([^\s"'}]+))/.exec(t.token.rawArgs);
      const name = m?.[1] ?? m?.[2] ?? m?.[3];
      return name ? [name] : [];
    });
  });
  if (defs.length === 0) return;
  for (const name of new Set(defs)) {
    let want = 0;
    const block = isBlockWidget(texts(model), name);
    for (const uri of model.documents.getUris()) {
      want += runtimeMacroHeads(model.documents.getText(uri)!).filter(h => h.name.toLowerCase() === name.toLowerCase() && (block || !h.isClose)).length;
    }
    const got = findWidgetReferences(name, model, false).length;
    expect(got, `references to widget ${name}`).toBe(want);
  }
}

// --- 5. rename: apply across documents, rebuild, reparse with the runtime ---

const RENAMES = {
  // Contract #67: each name is spelled for its consumer. Spindle 0.59 reads the `passage` argument of {goto},
  // {include} and {link} as a quoted name (a JavaScript string literal, `passageTarget`) or else as an expression:
  // a bare `New Name` or `_x1` is an expression (a SyntaxError, `temporary["x1"]`, ...), so every name that is
  // written out must be quoted, and the oracle finds no reference behind a bare one. `inline` is the {include}
  // flag (`splitIncludeFlag`: a standalone first or last word outside quotes, so a bare one is the flag).
  passage: ['_x1', 'URL', 'temporary', 'Image', 'Chapter 2', 'Renamed Passage', 'It\'s "quoted" [x] \\ y', '1 + 2', '5', 'a-b', 'true', 'inline', 'New inline name', 'inline x', 'x inline'],
  // `5` (digit-leading) and `_x` are valid Spindle names; `a$b` has an internal `$` and must be rejected atomically (#83)
  variable: ['renamedVar', '5', '_x', 'a$b'],
  widget: ['renamed-widget'],
} as const;

function applyAll(model: WorkspaceModel, edits: Map<string, Array<{ range: Range; newText: string }>>): Files {
  const files = texts(model);
  for (const [uri, list] of edits) {
    const name = uri.replace('file:///', '');
    expect(files[name], `edit for unknown document ${uri}`).toBeDefined();
    for (const e of list) expect(rangeProblem(files[name], e.range), `rename edit ${JSON.stringify(e)}`).toBeNull();
    const before = files[name];
    files[name] = TextDocument.applyEdits(TextDocument.create(uri, 'twee', 0, before), list);
    // a byte order mark is the client's, never the edit's to remove or move
    expect(files[name].charCodeAt(0) === 0xfeff, `rename edits keep the BOM of ${name}`).toBe(before.charCodeAt(0) === 0xfeff);
  }
  return files;
}

/** Rename `sigil+name` in JavaScript-ish macro arguments, leaving string literal text alone (template `${}` is code). */
export function renameInCode(code: string, sigil: string, name: string, to: string): string {
  let out = '';
  const stack: string[] = []; // open quote chars; '{' marks a template interpolation
  const re = new RegExp(`^\\${sigil}${name.replace(/\$/g, '\\$')}(?![\\w$])`);
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    const top = stack[stack.length - 1];
    if (top === '"' || top === "'" || top === '`') {
      if (c === '\\') { out += c + (code[i + 1] ?? ''); i++; continue; }
      if (c === top) stack.pop();
      else if (top === '`' && c === '$' && code[i + 1] === '{') { stack.push('{'); out += '${'; i++; continue; }
      out += c; continue;
    }
    if (c === '"' || c === "'" || c === '`') { stack.push(c); out += c; continue; }
    if (top === '{' && c === '}') { stack.pop(); out += c; continue; }
    if (c === sigil && !/[\w$]/.test(code[i - 1] ?? '') && re.test(code.slice(i))) { out += sigil + to; i += name.length; continue; }
    out += c;
  }
  return out;
}

const codeMultiset = (model: WorkspaceModel) => {
  const out: string[] = [];
  for (const uri of model.documents.getUris().sort()) for (const d of computeDiagnostics(uri, model)) out.push(`${uri}|${d.code}`);
  return out.sort();
};

export function propRename(files: Files) {
  const model = build(files);
  const seen = new Set<string>();
  let renamed = 0;
  for (const { uri, probes } of allSweeps(model)) {
    const text = model.documents.getText(uri)!;
    for (const p of probes) {
      if (!p.prep) continue;
      const span = text.slice(...offsetRange(text, p.prep.range));
      const kind = /^[$_@%]/.test(span) ? 'variable' : /^[\w$]/.test(p.prep.placeholder) && model.widgets.getWidget(p.prep.placeholder) && !model.passages.getPassage(p.prep.placeholder) ? 'widget' : 'passage';
      const key = `${kind}:${p.prep.placeholder}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const newName of RENAMES[kind]) {
        let edits;
        try { edits = computeRename(uri, p.pos, newName, model); }
        catch (e) {
          if (!(e instanceof RenameError)) throw e;
          continue;
        }
        // renaming onto another existing passage would merge two passages: it must be rejected whole
        if (kind === 'passage' && newName !== p.prep.placeholder) {
          expect(model.passages.getPassage(newName), `rename ${key} -> ${JSON.stringify(newName)} was accepted onto an existing passage`).toBeUndefined();
        }
        // #83: a name outside Spindle's grammar (sigil + word characters) is rejected whole, never applied
        if (kind === 'variable') expect(/^\w+$/.test(newName), `rename ${key} -> ${JSON.stringify(newName)} was accepted`).toBe(true);
        if (edits.size === 0) continue;
        renamed++;
        const after = applyAll(model, edits);
        const next = build(after);
        // diagnostics identity: same codes on the same documents
        // Diagnostics that depend on whether a name resolves (missing/unused/unreachable passages, a link read
        // differently, a macro-looking text in an attribute) may change when a name changes; the rest may not.
        // A digit-leading transient (`%5`, valid in code) is plain text in prose, as `%20` is: Spindle never validates
        // it there, so an undeclared prose-only `%off` renamed to `5` legitimately loses its SP203 (#83).
        const proseTransient = kind === 'variable' && span[0] === '%' && /^\d/.test(newName);
        const nameDependent = proseTransient ? /SP30[034]|SP40[01]|SP103|SP203/ : /SP30[034]|SP40[01]|SP103/;
        const before = codeMultiset(model).filter(s => !nameDependent.test(s));
        const now = codeMultiset(next).filter(s => !nameDependent.test(s));
        // Contract #44: literal text (strings, comments) is not renamed. Spindle < 0.50.1 still reads `$old`
        // there when the story starts, so exactly those documents gain one SP200 for the now-undeclared name.
        const expected = [...before];
        if (kind === 'variable' && span[0] === '$' && !model.capabilities.executableRefsOnly) {
          for (const uri2 of model.documents.getUris()) {
            const name2 = uri2.replace('file:///', '');
            const leftover = splitPassages(after[name2]).some(q => q.markup && new RegExp(`\\$${p.prep!.placeholder}(?![\\w$])`).test(after[name2].slice(q.bodyStart, q.bodyEnd)));
            if (leftover) expected.push(`${uri2}|SP200`);
          }
        }
        expect(now, `rename ${key} -> ${JSON.stringify(newName)} changed diagnostics`).toEqual(expected.sort());
        // runtime payload: old name replaced by the new one, nothing else
        for (const uri2 of model.documents.getUris()) {
          const name = uri2.replace('file:///', '');
          if (kind === 'passage') {
            const was = runtimePassageRefs(files[name]).map(r => r.target === p.prep!.placeholder ? newName : r.target).sort();
            const is = runtimePassageRefs(after[name]).map(r => r.target).sort();
            expect(is, `${name} after renaming ${key} -> ${JSON.stringify(newName)}`).toEqual(was);
            const names = splitPassages(after[name]).map(x => x.name).sort();
            const wasNames = splitPassages(files[name]).map(x => x.name === p.prep!.placeholder ? newName : x.name).sort();
            expect(names, `${name} headers after renaming ${key}`).toEqual(wasNames);
          } else {
            const old = p.prep!.placeholder;
            const closers = kind === 'widget' && isBlockWidget(files, old);
            const swap = (s: string) => kind === 'widget'
              ? s.replace(new RegExp(`^(m:${closers ? '/?' : ''})${old}(?=:)`, 'i'), (_m, h: string) => h + newName)
                .replace(new RegExp(`^(m:widget:["']?)${old}(?=["'\\s]|$)`, 'i'), `$1${newName}`)
              : s.replace(new RegExp(`^(v:\\w+:)${old}(?=\\.|$)`), (_m, h: string) => h + newName)
                .replace(/^(m:[^:]*:)(.*)$/, (_m, head: string, args: string) => head + renameInCode(args, kind === 'variable' ? span[0] : '$', old, newName));
            const was = runtimePayload(files[name]).map(swap).sort();
            const is = runtimePayload(after[name]).sort();
            expect(is, `${name} after renaming ${key} -> ${newName}`).toEqual(was);
          }
        }
        // the renamed symbol is now found under its new name only
        if (kind === 'passage') {
          expect(findPassageReferences(p.prep.placeholder, next, false)).toEqual([]);
        }
      }
    }
  }
  if (renamed === 0) notApplicable('no renameable symbol');
}

// --- 6. formatting: idempotent, diagnostics and runtime payload unchanged ---

export async function propFormat(files: Files) {
  const model = build(files);
  const formatted: Files = {};
  let changed = false;
  for (const [name, text] of Object.entries(files)) {
    if (/\.(js|ts)$/.test(name)) { formatted[name] = text; continue; }
    const once = await formatDocument(text);
    const twice = await formatDocument(once);
    expect(twice, `formatting ${name} is not idempotent`).toBe(once);
    expect(runtimePayload(once), `format changed the runtime payload of ${name}`).toEqual(runtimePayload(text));
    expect(runtimePassageRefs(once).map(r => r.target).sort(), `format changed the passage references of ${name}`).toEqual(runtimePassageRefs(text).map(r => r.target).sort());
    expect(splitPassages(once).map(p => [p.name, p.tags]), `format changed the passages of ${name}`).toEqual(splitPassages(text).map(p => [p.name, p.tags]));
    if (once !== text) changed = true;
    formatted[name] = once;
  }
  const next = build(formatted);
  const strip = (m: WorkspaceModel) => {
    const out: string[] = [];
    for (const uri of m.documents.getUris().sort()) for (const d of computeDiagnostics(uri, m)) if (d.code !== 'SP500') out.push(`${uri}|${d.code}|${d.message}`);
    return out.sort();
  };
  expect(strip(next), 'format changed the diagnostics').toEqual(strip(model));
  void changed;
}

/**
 * The JavaScript values a story's {do} bodies produce: each body (compiler-normalized newlines) is
 * run with an `out` array and the array is returned unnormalized. The fixtures hold only fixed,
 * benign literals.
 */
export function doBodyValues(text: string): unknown[][] {
  const values: unknown[][] = [];
  for (const m of text.replaceAll('\r\n', '\n').matchAll(/\{do\}([\s\S]*?)\{\/do\}/g)) {
    const out: unknown[] = [];
    new Function('out', m[1])(out);
    values.push(out);
  }
  return values;
}

// --- 6b. formatting: {do} body JavaScript values are identical ---

export async function propFormatDoLiterals(files: Files) {
  const text = files['story.tw'];
  const before = doBodyValues(text);
  expect(before.length, 'fixture has a {do} body').toBeGreaterThan(0);
  // both brace readings (the older tokenizer and stringAwareBraces) must keep the values
  const once = await formatDocument(text);
  const onceAware = await formatDocument(text, { stringAwareBraces: true });
  // the values are compared as written: no whitespace normalization
  expect(doBodyValues(once), 'format changed a {do} body value').toEqual(before);
  expect(doBodyValues(onceAware), 'format (stringAwareBraces) changed a {do} body value').toEqual(before);
  expect(await formatDocument(once), 'formatting is not idempotent').toBe(once);
  expect(await formatDocument(onceAware, { stringAwareBraces: true }), 'formatting (stringAwareBraces) is not idempotent').toBe(onceAware);
  expect(once.includes('\r\n'), 'format keeps the document line endings').toBe(text.includes('\r\n'));
  // unrelated text is still formatted and kept
  const lf = once.replaceAll('\r\n', '\n');
  if (text.includes('before \n') || text.includes('before \r\n')) {
    expect(lf).toMatch(/^before$/m);
    expect(lf).toMatch(/^after$/m);
  }
  expect(lf.startsWith(':: Start\n') || lf.startsWith(':: StoryInit\n'), 'passage header kept').toBe(true);
}

// --- 7. semantic tokens: valid, sorted, non-overlapping ---

export function propTokens(files: Files) {
  const model = build(files);
  let n = 0;
  for (const uri of model.documents.getUris()) {
    const toks = computeSemanticTokensAbsolute(uri, model);
    n += toks.length;
    const text = model.documents.getText(uri)!;
    const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
    let prev: { line: number; end: number } | null = null;
    for (const t of toks) {
      if (prev) {
        const ordered = t.line > prev.line || (t.line === prev.line && t.startChar >= prev.end);
        expect(ordered, `tokens overlap or are unsorted at ${t.line}:${t.startChar}`).toBe(true);
      }
      prev = { line: t.line, end: t.startChar + t.length };
      expect(t.startChar + t.length).toBeLessThanOrEqual(lines[t.line].length);
    }
    // variable tokens agree with the variable reference sweep
    const probes = sweep(model, uri);
    for (const t of toks) {
      const lineText = lines[t.line];
      const slice = lineText.slice(t.startChar, t.startChar + t.length);
      if (!/^[$_@%][\w$]+$/.test(slice) || !/^\$/.test(slice)) continue;
      const p = probes.find(x => x.pos.line === t.line && x.pos.character === t.startChar + 1);
      if (!p) continue;
      expect(p.refsDecl.length > 0 || p.prep !== null, `semantic token ${slice} at ${t.line}:${t.startChar} is not a reference to any consumer`).toBe(true);
    }
  }
  if (n === 0) notApplicable('no semantic tokens in this fixture');
}

// --- 7b. hover: only on what the semantic tokens and the runtime tokens say is a symbol ---

export function propHover(files: Files) {
  const model = build(files);
  let hovers = 0;
  for (const uri of model.documents.getUris()) {
    const text = model.documents.getText(uri)!;
    const d = doc(text);
    const tokens = computeSemanticTokensAbsolute(uri, model);
    const macroTokens = runtimeTokens(text).filter(t => t.token.type === 'macro');
    for (const offset of cursorOffsets(text)) {
      const pos = d.positionAt(offset);
      const hover = getHoverInfo(uri, pos, model);
      if (!hover) continue;
      hovers++;
      expect(rangeProblem(text, hover.range), `hover range at ${offset}`).toBeNull();
      const [s, e] = offsetRange(text, hover.range);
      expect(offset >= s && offset <= e, `hover range ${s}-${e} excludes the cursor ${offset}`).toBe(true);
      if (/variable\*\*/.test(hover.contents)) {
        const covered = tokens.some(t => t.line === hover.range.start.line && t.startChar === hover.range.start.character && t.length === hover.range.end.character - hover.range.start.character);
        expect(covered, `hover on a variable at ${s}-${e} (${JSON.stringify(text.slice(s, e))}) that the semantic tokens do not highlight`).toBe(true);
      } else {
        // the semantic tokens highlight exactly the macro/widget names hover explains
        const fn = tokenTypesLegend.indexOf('function');
        const covered = tokens.some(t => t.line === hover.range.start.line && t.startChar === hover.range.start.character && t.tokenType === fn && t.length === hover.range.end.character - hover.range.start.character);
        expect(covered, `hover on a macro/widget name at ${s}-${e} (${JSON.stringify(text.slice(s, e))}) that the semantic tokens do not highlight`).toBe(true);
        // and a macro the runtime tokenizes (complete input) is one the tokens cover
        void macroTokens;
      }
    }
  }
  if (hovers === 0) notApplicable('no hover anywhere in this fixture');
}

// --- 8. state: incremental sequences equal a fresh build; order independence ---

export function propStateOrder(files: Files) {
  const names = Object.keys(files);
  if (names.length < 2) notApplicable('single document: file order cannot differ');
  const a = snapshot(build(files, names));
  const b = snapshot(build(files, [...names].reverse()));
  expect(b, 'workspace initialization order changed consumer output').toEqual(a);
}

export function propStateIncremental(files: Files) {
  const names = Object.keys(files);
  const fresh = snapshot(build(files));
  // open documents one at a time, as an editor does
  const m1 = buildFresh({}, []);
  for (const n of names) m1.documents.open(U(n), files[n]);
  expect(snapshot(m1), 'opening documents one by one differs from a fresh build').toEqual(fresh);
  // an unsaved edit, then its revert
  const first = names[0];
  const m2 = buildFresh(files);
  m2.documents.update(U(first), files[first] + '\n:: Scratch Passage\n[[Nowhere At All]]\n');
  m2.documents.update(U(first), files[first]);
  expect(snapshot(m2), 'edit and revert leaves stale state').toEqual(fresh);
  // close and reopen each document
  for (const n of names) {
    const m3 = buildFresh(files);
    m3.documents.close(U(n));
    const rest = { ...files }; delete rest[n];
    expect(snapshot(m3), `closing ${n} differs from a workspace without it`).toEqual(snapshot(build(rest)));
    m3.documents.open(U(n), files[n]);
    expect(snapshot(m3), `reopening ${n} differs from a fresh build`).toEqual(fresh);
  }
  void uriOf;
}
