/**
 * Retained cross-consumer matrix (see docs/reviews/process.md and
 * docs/reviews/2026-10-06-cross-consumer.md).
 *
 * Cells are NAMED selections from {passage role} x {source context} x
 * {spelling} x {boundary} x {state} x {consumer}; this is not a Cartesian
 * product. Each cell has a pass / fail / not-run / not-applicable status that
 * is written to docs/reviews/2026-10-06-cross-consumer-results.json (set
 * REVIEW_WRITE_RESULTS=1 to regenerate it; the last test in this file checks
 * that the committed file lists the cells and states of the current run).
 * The installed Spindle (tokenize / buildAST / link macro parseArgs) is the
 * oracle: see test/review/support/oracle.ts.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSTALLED_SPINDLE_VERSION } from '../helpers/spindle-version.js';
import {
  NotApplicable, disposeAll, notApplicable, records, root,
  type CellRecord, type Dims, type Files,
} from './support/harness.js';
import {
  propBounds, propFormat, propHover, propMacroHeadOracle, propNavigationAgree, propPassageOracle,
  propRename, propStateIncremental, propStateOrder, propTokens,
} from './support/properties.js';
import { registerInteractiveCells } from './support/interactive.js';

const RESULTS = join(root, 'docs/reviews/2026-10-06-cross-consumer-results.json');

afterEach(() => disposeAll());

/** Declares one cell: an `it` whose outcome is recorded. */
export function cell(id: string, dims: Dims, fn: () => void | Promise<void>) {
  it(id, async () => {
    const rec: CellRecord = { id, ...dims, status: 'pass' };
    records.push(rec);
    try {
      await fn();
    } catch (error) {
      if (error instanceof NotApplicable) { rec.status = 'not-applicable'; rec.note = error.message; return; }
      rec.status = 'fail';
      rec.note = String((error as Error).message).split('\n')[0].slice(0, 300);
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------------

const STORY_DATA = '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"Spindle","format-version":"0.45.1"}';
const BASE = `:: StoryData\n${STORY_DATA}\n\n:: StoryVariables\n$v = 0\n$o = {"a": {"b": 1}, "name": "x"}\n\n:: StoryTransients\n%tr = 0\n`;
const TARGET_FILE = ':: Target\nThe target.\n';

type Role = 'ordinary' | 'widget' | 'StoryInit' | 'StoryInterface' | 'StoryData' | 'StoryVariables' | 'StoryTransients' | 'script' | 'stylesheet';
const ROLES: Role[] = ['ordinary', 'widget', 'StoryInit', 'StoryInterface', 'StoryData', 'StoryVariables', 'StoryTransients', 'script', 'stylesheet'];

/** Wrap a snippet in a passage of the given role (as its own document). */
function inRole(role: Role, s: string): string {
  switch (role) {
    case 'ordinary': return `:: Start\n${s}\n`;
    case 'widget': return `:: Wrole [widget]\n{widget "wrole"}\n${s}\n{/widget}\n`;
    case 'StoryInit': return `:: StoryInit\n${s}\n`;
    case 'StoryInterface': return `:: StoryInterface\n${s}\n`;
    case 'StoryData': return `:: StoryData\n${STORY_DATA}\n${s}\n`;
    case 'StoryVariables': return `:: StoryVariables\n$v = 0\n${s}\n`;
    case 'StoryTransients': return `:: StoryTransients\n%tr = 0\n${s}\n`;
    case 'script': return `:: Code [script]\nvar x = 1;\n${s}\n`;
    case 'stylesheet': return `:: Style [stylesheet]\n.a { color: red; }\n${s}\n`;
  }
}

interface Scene {
  id: string;
  dims: Omit<Dims, 'consumer'>;
  files: Files;
}

const T = 'Target';
const CONTEXTS: Record<string, (t: string) => string> = {
  'bracket-plain': t => `[[${t}]]`,
  'bracket-pipe': t => `[[go|${t}]]`,
  'bracket-arrow': t => `[[go->${t}]]`,
  'bracket-reverse': t => `[[${t}<-go]]`,
  'bracket-two-pipes': t => `[[a|b|${t}]]`,
  'goto-double': t => `{goto "${t}"}`,
  'goto-single': t => `{goto '${t}'}`,
  'goto-template': t => '{goto `' + t + '`}',
  'goto-concat-dynamic': t => `{goto "${t}" + "x"}`,
  'goto-variable-dynamic': () => '{goto $v}',
  'include-double': t => `{include "${t}"}`,
  'link-macro-double': t => `{link "go" "${t}"}x{/link}`,
  'link-macro-single': t => `{link 'go' '${t}'}x{/link}`,
  'link-macro-block': t => `{link "${t}"}go{/link}`,
  'goto-css-selector': t => `{.cls goto "${t}"}`,
  'goto-in-if': t => `{if $v}{goto "${t}"}{/if}`,
  'bracket-in-element': t => `<b>[[${t}]]</b>`,
  'bracket-in-attr': t => `<a title="[[${t}]]">x</a>`,
  'macro-in-attr': t => `<a title="{goto '${t}'}">x</a>`,
  'bracket-in-comment': t => `<!-- [[${t}]] -->`,
  'goto-in-comment': t => `<!-- {goto "${t}"} -->`,
  'bracket-in-string-arg': t => `{set $v = "[[${t}]]"}`,
  'name-in-prose': t => `see ${t} here`,
  'name-in-quoted-prose': t => `"${t}"`,
  'multiple-per-line': t => `[[${t}]] [[x|${t}]] {goto "${t}"}`,
  'var-set': () => '{set $v = 1}{$v}',
  'var-bare-token': () => 'value $v here',
  'var-property-path': () => '{set $o.a.b = 2}{$o.name}',
  'var-in-string': () => '{set $v = "$v"}',
  'var-in-comment': () => '<!-- $v -->',
  'var-in-attr': () => '<p class="$v">x</p>',
  'var-template-literal': () => '{print `${$v}`}',
  'var-temp-local-transient': () => '{set _t = 1}{_t} {%tr}',
  'widget-use': () => '{wid}',
  'widget-use-css': () => '{wid.cls}',
  'widget-in-comment': () => '<!-- {wid} -->',
  'widget-in-string': () => '{set $v = "{wid}"}',
  'widget-in-attr': () => '<p title="{wid}">x</p>',
  'widget-block-pair': () => '{wid}{/wid}',
  'widget-block-real': () => '{bw}x{/bw}',
  'unknown-macro': () => '{nosuchmacro 1}',
  'transient-in-prose': () => 'sale 50 %off today',
  'transient-in-attr': () => '<p class="%tr">x</p>',
  'transient-in-comment': () => '<!-- %tr -->',
  'link-label-interpolation': t => `[[{$v} go|${t}]]`,
  'bracket-css-selector': t => `[[.cls#id go|${t}]]`,
  'macro-multiline-args': t => `{set $v =\n  1}\n{goto\n  "${t}"}`,
  'goto-uppercase-head': t => `{GOTO "${t}"}`,
  'goto-space-after-brace': t => `{ goto "${t}"}`,
  'goto-two-literals': t => `{goto "${t}" "${t}"}`,
  'goto-bare-identifier': t => `{goto ${t}}`,
  'goto-parenthesized': t => `{goto ("${t}")}`,
  'goto-trailing-space': t => `{goto "${t}"  }`,
  'bracket-multiline': t => `[[go\n${t}]]`,
  'bracket-nested-brackets': t => `[[${t}]]]`,
  'bracket-unterminated-then-link': t => `[[ unterminated\n[[${t}]]`,
  'html-comment-multiline': t => `<!--\n[[${t}]]\n-->`,
  'script-tag-contents': t => `<script>var x = "[[${t}]]";</script>`,
  'style-tag-contents': () => '<style>.a { content: "$v"; }</style>',
  'prose-only': () => 'Just words.',
};
const WIDGET_FILE = ':: Widgets [widget]\n{widget "wid"}\ninside\n{/widget}\n\n:: BlockWidgets [widget]\n{widget "bw"}\n<b>{@children}</b>\n{/widget}\n';

const scenes: Scene[] = [];
function scene(id: string, dims: Omit<Dims, 'consumer'>, files: Files) { scenes.push({ id, dims, files }); }
function files(story: string, extra: Files = {}): Files {
  // a story document that declares StoryData/StoryVariables/StoryTransients itself is the only declaration
  const own = (['StoryData', 'StoryVariables', 'StoryTransients'] as const).filter(n => story.includes(`:: ${n}\n`));
  const base = own.length === 0 ? BASE : BASE.split('\n\n').filter(part => !own.some(n => part.startsWith(`:: ${n}`))).join('\n\n');
  return { 'story.tw': story, 'target.tw': TARGET_FILE, ...(base.trim() ? { 'base.tw': base } : {}), 'widgets.tw': WIDGET_FILE, ...extra };
}

// Family A: passage role x core contexts
const CORE = ['bracket-plain', 'bracket-pipe', 'goto-double', 'link-macro-double', 'bracket-in-comment', 'bracket-in-string-arg', 'var-set', 'widget-use', 'multiple-per-line'];
for (const role of ROLES) {
  for (const ctx of CORE) {
    scene(`A/${role}/${ctx}`, { role, context: ctx, spelling: 'plain', boundary: 'eof-newline', state: 'multi-file' }, files(inRole(role, CONTEXTS[ctx](T))));
  }
}
// Family B: contexts in an ordinary passage, plain spelling
for (const [ctx, make] of Object.entries(CONTEXTS)) {
  if (CORE.includes(ctx)) continue;
  scene(`B/ordinary/${ctx}`, { role: 'ordinary', context: ctx, spelling: 'plain', boundary: 'eof-newline', state: 'multi-file' }, files(inRole('ordinary', make(T))));
}
// Family C: target spellings across the four reference syntaxes
const SPELLINGS: Record<string, { header: string; name: string; goto: string; single: string }> = {
  'two-words': { header: 'Two Words', name: 'Two Words', goto: 'Two Words', single: 'Two Words' },
  hyphenated: { header: 'Hyphen-ated', name: 'Hyphen-ated', goto: 'Hyphen-ated', single: 'Hyphen-ated' },
  unicode: { header: 'Ünï Çode', name: 'Ünï Çode', goto: 'Ünï Çode', single: 'Ünï Çode' },
  astral: { header: '𝒜 Gate 🚪', name: '𝒜 Gate 🚪', goto: '𝒜 Gate 🚪', single: '𝒜 Gate 🚪' },
  apostrophe: { header: "Don't Stop", name: "Don't Stop", goto: "Don't Stop", single: "Don\\'t Stop" },
  'double-quote': { header: 'Say "hi"', name: 'Say "hi"', goto: 'Say \\"hi\\"', single: 'Say "hi"' },
  backslash: { header: 'Back\\\\slash', name: 'Back\\slash', goto: 'Back\\\\slash', single: 'Back\\\\slash' },
  'escaped-brackets-header': { header: 'A\\[B\\]', name: 'A[B]', goto: 'A[B]', single: 'A[B]' },
  'escaped-braces-header': { header: 'A\\{B\\}', name: 'A{B}', goto: 'A{B}', single: 'A{B}' },
  'pipe-in-name': { header: 'Left|Right', name: 'Left|Right', goto: 'Left|Right', single: 'Left|Right' },
  'leading-trailing-space-like': { header: 'Tab\tName', name: 'Tab\tName', goto: 'Tab\\tName', single: 'Tab\\tName' },
  'dollar-and-percent': { header: 'Price $ 100%', name: 'Price $ 100%', goto: 'Price $ 100%', single: 'Price $ 100%' },
};
for (const [spelling, s] of Object.entries(SPELLINGS)) {
  const targetFile = `:: ${s.header}\nbody\n`;
  const syntaxes: Record<string, string> = {
    'bracket-plain': `[[${s.name}]]`,
    'bracket-pipe': `[[go|${s.name}]]`,
    'goto-double': `{goto "${s.goto}"}`,
    'link-macro-single': `{link 'go' '${s.single}'}x{/link}`,
    'include-double': `{include "${s.goto}"}`,
  };
  for (const [ctx, snippet] of Object.entries(syntaxes)) {
    scene(`C/${spelling}/${ctx}`, { role: 'ordinary', context: ctx, spelling, boundary: 'eof-newline', state: 'multi-file' },
      { 'story.tw': inRole('ordinary', snippet), 'target.tw': targetFile, 'base.tw': BASE });
  }
}
// Hyphenated widget spelling (case-insensitive, hyphen, sigil params)
for (const [spelling, def, use] of [
  ['hyphenated-widget', 'my-widget', '{my-widget}'],
  ['widget-mixed-case', 'MyWidget', '{mywidget}'],
  ['widget-bare-name', 'bare', '{bare}'],
  ['widget-single-quoted', 'sq', '{sq}'],
] as const) {
  const quote = spelling === 'widget-bare-name' ? '' : spelling === 'widget-single-quoted' ? "'" : '"';
  scene(`C/${spelling}/widget-use`, { role: 'ordinary', context: 'widget-use', spelling, boundary: 'eof-newline', state: 'multi-file' },
    { 'story.tw': inRole('ordinary', `${use} and ${use} {set $v = 1}`), 'widgets.tw': `:: W [widget]\n{widget ${quote}${def}${quote}}\nx\n{/widget}\n`, 'base.tw': BASE });
}
// Sigil spellings
for (const [spelling, snippet] of [
  ['sigil-story', '{set $v = 1}{$v}'],
  ['sigil-temp', '{set _t = 1}{_t}'],
  ['sigil-local', '{widget "loc" @p}{@p}{/widget}'],
  ['sigil-transient', '{set %tr = 1}{%tr}'],
  ['sigil-adjacent', '$v$v $v.x $v_ $$v'],
] as const) {
  scene(`C/${spelling}/var`, { role: 'ordinary', context: 'variable', spelling, boundary: 'eof-newline', state: 'multi-file' }, files(inRole('ordinary', snippet)));
}

// Family D: boundaries
const BOUNDARY_CORE: Record<string, string> = {
  bracket: `[[${T}]]`,
  goto: `{goto "${T}"}`,
  variable: '{set $v = 1}{$v}',
  widget: '{wid}',
};
const BOUNDARIES: Record<string, (s: string) => string> = {
  'eof-no-newline': s => `:: Start\n${s}`,
  'eof-newline': s => `:: Start\n${s}\n`,
  'eof-blank-lines': s => `:: Start\n${s}\n\n\n`,
  crlf: s => `:: Start\r\n${s}\r\n`,
  'crlf-no-final-eol': s => `:: Start\r\n${s}`,
  'mixed-eol': s => `:: Start\r\nline\n${s}\r\n`,
  'astral-prefix': s => `:: Start\n😀𝒜 ${s} 😀\n`,
  'astral-prefix-crlf': s => `:: Start\r\n😀𝒜 ${s}\r\n`,
  'multiline-macro': s => `:: Start\n{if $v}\n  ${s}\n{/if}\n`,
  'empty-passage-before': s => `:: Empty\n\n:: Start\n${s}\n`,
  'empty-passage-after': s => `:: Start\n${s}\n:: Empty\n`,
  'header-only-eof': s => `:: Start\n${s}\n:: Last`,
  'unicode-line-separator': s => `:: Start\nA\u2028B ${s}\n`,
  'tabs-and-trailing-space': s => `:: Start  \n\t${s}\t \n`,
  'bom-first-header': s => `\uFEFF:: Start\n${s}\n`,
  'header-with-tags-meta': s => `:: Start [tag1 tag2] {"position":"1,1","size":"100,100"}\n${s}\n`,
  'long-line': s => `:: Start\n${'x '.repeat(400)}${s}\n`,
  'two-passages-share-line-text': s => `:: Start\n${s}\n\n:: Second\n${s}\n`,
  'incomplete-open-brace': s => `:: Start\n${s}\n{goto "Tar`,
  'incomplete-open-bracket': s => `:: Start\n${s}\n[[Tar`,
  'incomplete-comment': s => `:: Start\n${s}\n<!-- [[Target]] `,
  'incomplete-string': s => `:: Start\n${s}\n{set $v = "unterminated`,
  'first-line-no-header': s => `${s}\n`,
};
for (const [bname, wrap] of Object.entries(BOUNDARIES)) {
  for (const [cname, snippet] of Object.entries(BOUNDARY_CORE)) {
    scene(`D/${bname}/${cname}`, { role: 'ordinary', context: cname, spelling: 'plain', boundary: bname, state: 'multi-file' }, files(wrap(snippet)));
  }
}
// An empty document, an empty passage and a lone header as the only content
for (const [name, text] of [['empty-document', ''], ['only-header', ':: Only'], ['only-header-eol', ':: Only\n'], ['whitespace-only', '  \n\n'], ['only-crlf-header', ':: Only\r\n']] as const) {
  scene(`D/${name}/none`, { role: 'ordinary', context: 'none', spelling: 'plain', boundary: name, state: 'multi-file' }, { 'story.tw': text, 'target.tw': TARGET_FILE });
}
// Same-document target, the only document, config first
scene('E/single-file/bracket', { role: 'ordinary', context: 'bracket-plain', spelling: 'plain', boundary: 'eof-newline', state: 'single-file' },
  { 'story.tw': `:: Start\n[[${T}]] {goto "${T}"}\n\n:: ${T}\nbody\n` });
scene('E/config-first/goto', { role: 'ordinary', context: 'goto-double', spelling: 'plain', boundary: 'eof-newline', state: 'config-opened-first' },
  { 'spindle.config.yaml': 'macros:\n  shout:\n    description: Shout\n', 'macros.js': 'export const x = 1;\n', 'story.tw': inRole('ordinary', `{goto "${T}"}{shout}`), 'target.tw': TARGET_FILE, 'base.tw': BASE });
scene('E/duplicate-passage/bracket', { role: 'ordinary', context: 'bracket-plain', spelling: 'plain', boundary: 'eof-newline', state: 'duplicate-names' },
  { 'story.tw': inRole('ordinary', `[[${T}]]`), 'target.tw': TARGET_FILE, 'target2.tw': TARGET_FILE });
scene('E/js-source/goto', { role: 'script', context: 'goto-double', spelling: 'plain', boundary: 'eof-newline', state: 'js-document' },
  { 'story.tw': inRole('ordinary', `{goto "${T}"}`), 'target.tw': TARGET_FILE, 'macros.js': `// [[${T}]] {goto "${T}"}\nStory.defineMacro({name:'x'});\n` });
scene('E/two-stories/unicode-order', { role: 'ordinary', context: 'multiple-per-line', spelling: 'astral', boundary: 'astral-prefix', state: 'multi-file' },
  { 'a.tw': ':: A 😀\n😀 [[B 𝒜]] {goto "B 𝒜"}\n', 'b.tw': ':: B 𝒜\n😀 [[A 😀]]\n' });

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const STATE_SUBSET = new Set([
  'A/ordinary/bracket-plain', 'A/ordinary/goto-double', 'A/ordinary/var-set', 'A/ordinary/widget-use',
  'A/widget/goto-double', 'A/StoryInit/link-macro-double', 'A/script/bracket-plain',
  'B/ordinary/bracket-in-attr', 'B/ordinary/var-property-path', 'B/ordinary/widget-block-pair',
  'D/crlf/bracket', 'D/astral-prefix/goto', 'D/incomplete-open-bracket/bracket', 'D/eof-no-newline/variable',
  'E/config-first/goto', 'E/single-file/bracket', 'E/js-source/goto', 'E/duplicate-passage/bracket',
  'E/two-stories/unicode-order', 'C/astral/bracket-plain', 'C/escaped-brackets-header/goto-double',
]);

describe('cross-consumer matrix', () => {
  for (const s of scenes) {
    const d = (consumer: string): Dims => ({ ...s.dims, consumer });
    cell(`${s.id} [bounds]`, d('all consumers: ranges within document and UTF-16 valid'), () => propBounds(s.files));
    cell(`${s.id} [navigation]`, d('references x definition x prepareRename'), () => propNavigationAgree(s.files));
    cell(`${s.id} [passage-oracle]`, d('diagnostics x references x document links x code lens vs runtime'), () => propPassageOracle(s.files));
    cell(`${s.id} [macro-oracle]`, d('diagnostics x semantic tokens x widget references vs runtime'), () => propMacroHeadOracle(s.files));
    cell(`${s.id} [rename]`, d('prepareRename/rename applied, rebuilt, re-diagnosed, reparsed'), () => propRename(s.files));
    cell(`${s.id} [format]`, d('formatting: idempotent, same diagnostics, same runtime payload'), () => propFormat(s.files));
    cell(`${s.id} [hover]`, d('hover: variables and macros agree with semantic tokens and runtime tokens'), () => propHover(s.files));
    cell(`${s.id} [tokens]`, d('semantic tokens validity and agreement'), () => propTokens(s.files));
    if (STATE_SUBSET.has(s.id)) {
      cell(`${s.id} [state-order]`, { ...s.dims, state: 'initialization order permuted', consumer: 'all read-only consumers' }, () => propStateOrder(s.files));
      cell(`${s.id} [state-incremental]`, { ...s.dims, state: 'open one by one / unsaved edit+revert / close+reopen', consumer: 'all read-only consumers' }, () => propStateIncremental(s.files));
    }
  }
});

registerInteractiveCells(cell, { files, BASE, TARGET_FILE });

// Cells that are named, and decided, but have nothing to execute. Each carries its justification in the results file.
const NOT_APPLICABLE: Array<[string, Dims, string]> = [
  ['N/lone-cr-line-endings', { role: 'any', context: 'any', spelling: 'any', boundary: 'lone CR line endings', state: 'any', consumer: 'all' },
    'Twee 3 and Spindle\'s compiler know LF and CRLF only (the compiler normalizes CRLF to LF; a lone CR is an ordinary character in a header or macro). The server splits lines at LF everywhere, so a lone CR is not a line break to it, while the LSP position encoding counts it as one. Files with lone CR line endings are not Twee; boundary cells use LF, CRLF and mixed LF/CRLF.'],
  ['N/cli-document-lifecycle', { role: 'any', context: 'any', spelling: 'any', boundary: 'any', state: 'unsaved edit / add / remove / close document', consumer: 'CLI check/format' },
    'The CLI reads each file from disk once per run; there is no document lifecycle. The state differentials run in-process (state-order, state-incremental cells) and over JSON-RPC (I/entry-lsp-state/edit-close-reopen).'],
  ['N/mcp-entrypoint', { role: 'any', context: 'any', spelling: 'any', boundary: 'any', state: 'multi-file', consumer: 'MCP tools' },
    'The MCP tools call the same computeDiagnostics/formatDocument as the CLI (src/mcp/server.ts) and are covered end to end by test/integration/mcp.test.ts and test/integration/format-entrypoints.test.ts; the corpus compares the CLI and LSP entrypoints with the in-process consumers.'],
  ['N/spindle-version-state', { role: 'any', context: 'any', spelling: 'any', boundary: 'any', state: 'project format/version', consumer: 'all' },
    'The oracle is the installed Spindle (0.45.1). Other versions are exercised by running this same corpus against the packed releases (scripts/peer-matrix.sh layout; 0.43.0 and 0.51.3 results in docs/reviews/2026-10-06-cross-consumer.md) and by test/unit/spindle-capabilities.test.ts, whose flags decide every version-dependent expectation here.'],
  ['N/inlay-folding-symbols-actions', { role: 'any', context: 'any', spelling: 'any', boundary: 'any', state: 'any', consumer: 'inlay hints, folding ranges, document/workspace symbols, code actions' },
    'Not in the selected consumer set. Their own contracts live in test/unit/inlay-hints.test.ts, folding-range.test.ts, document-symbol.test.ts, workspace-symbol.test.ts, code-actions.test.ts and code-actions-config.test.ts (code actions consume the variable and passage references the corpus checks; hover is a corpus property).'],
  ['N/semantic-token-overlap-negotiation', { role: 'any', context: 'any', spelling: 'any', boundary: 'any', state: 'any', consumer: 'semantic tokens' },
    'The server never emits overlapping tokens (tokens property: sorted, non-overlapping on every scene), so there is no overlap behavior left to negotiate; the legend and delta encoding are covered by test/unit/semantic-tokens.test.ts.'],
];
describe('named cells without an executable check', () => {
  for (const [id, dims, reason] of NOT_APPLICABLE) cell(id, dims, () => notApplicable(reason));
});

// ---------------------------------------------------------------------------
// Retained results
// ---------------------------------------------------------------------------

afterAll(() => {
  if (!process.env.REVIEW_WRITE_RESULTS) return;
  const counts: Record<string, number> = { pass: 0, fail: 0, 'not-run': 0, 'not-applicable': 0 };
  for (const r of records) counts[r.status]++;
  writeFileSync(RESULTS, JSON.stringify({
    generated: '2026-10-06',
    spindleVersion: INSTALLED_SPINDLE_VERSION,
    summary: { total: records.length, ...counts },
    cells: records,
  }, null, 1) + '\n');
});

describe('retained results', () => {
  // When regenerating (REVIEW_WRITE_RESULTS=1) the file is rewritten after the run, so there is nothing to compare yet
  (process.env.REVIEW_WRITE_RESULTS ? it.skip : it)('docs/reviews/2026-10-06-cross-consumer-results.json lists every cell of this run with its status', () => {
    const file = JSON.parse(readFileSync(RESULTS, 'utf-8')) as { cells: CellRecord[] };
    const mine = new Map(records.map(r => [r.id, r.status]));
    const kept = new Map(file.cells.map(c => [c.id, c.status]));
    expect([...kept.keys()].sort()).toEqual([...mine.keys()].sort());
    for (const [id, status] of mine) expect(kept.get(id), id).toBe(status);
    expect(records.every(r => r.status !== 'not-run')).toBe(true);
  });
});
