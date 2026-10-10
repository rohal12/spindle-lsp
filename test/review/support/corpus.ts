/**
 * The corpus of the retained cross-consumer matrix: the fixtures, the named
 * scenes built from them, and the cells that have nothing to execute. It holds
 * no tests; the shard files (`*.review.ts`) register the cells through
 * `support/shards.ts`.
 */
import type { Dims, Files } from './harness.js';

// ---------------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------------

export const STORY_DATA = '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"Spindle","format-version":"0.45.1"}';
export const BASE = `:: StoryData\n${STORY_DATA}\n\n:: StoryVariables\n$v = 0\n$o = {"a": {"b": 1}, "name": "x"}\n\n:: StoryTransients\n%tr = 0\n`;
export const TARGET_FILE = ':: Target\nThe target.\n';

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

export interface Scene {
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
  'include-bare': t => `{include ${t}}`,
  'include-inline-after': t => `{include "${t}" inline}`,
  'include-inline-before': t => `{include inline "${t}"}`,
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
  // Raw {do} bodies (#70): from 0.50.1 the body is JavaScript text, so the strings are no references; before, they are markup. The oracle follows the installed tokenizer.
  'do-body-bracket-string': t => `{do}\nconst note = "[[${t}]]";\n{/do}`,
  'do-body-goto-string': t => `{do}\nconst n = '{goto "${t}"}';\n{/do}`,
  'do-body-link-macro-string': t => `{do}\nconst n = '{link "go" "${t}"}';\n{/do}`,
  'do-body-widget-var-string': () => '{do}\nconst n = "{wid} $v";\n{/do}',
  'do-body-inline-bracket': t => `{do}const n = "[[${t}]]";{/do}`,
  'do-body-then-link': t => `{do}\nconst n = "[[${t}]]";\n{/do} [[${t}]]`,
  'do-body-unclosed': t => `{do}\n[[${t}]]`,
};
const WIDGET_FILE = ':: Widgets [widget]\n{widget "wid"}\ninside\n{/widget}\n\n:: BlockWidgets [widget]\n{widget "bw"}\n<b>{@children}</b>\n{/widget}\n';

export const scenes: Scene[] = [];
function scene(id: string, dims: Omit<Dims, 'consumer'>, files: Files) { scenes.push({ id, dims, files }); }
export function files(story: string, extra: Files = {}): Files {
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
// Family C2 (#77): include targets that read differently per release. The target passage is [widget]-tagged
// and named `inline` (or `Other`), so SP302, references, definition and rename must all agree with the
// installed runtime on whether the quoted word is the flag (0.45.1) or the target (0.51.1+).
for (const [spelling, target, snippet] of [
  ['include-inline-quoted', 'inline', '{include "inline"}'],
  ['include-inline-quoted-flag-after', 'inline', '{include "inline" inline}'],
  ['include-inline-flag-before-quoted', 'inline', '{include inline "inline"}'],
  ['include-inline-escaped', 'inline', '{include "\\u0069nline"}'],
  ['include-widget-other-quoted', 'Other', '{include "Other"}'],
  ['include-widget-other-bare', 'Other', '{include Other}'],
  ['include-widget-other-flag-after', 'Other', '{include "Other" inline}'],
  ['include-widget-other-flag-before', 'Other', '{include inline Other}'],
  ['include-widget-malformed-escape', 'Other', '{include "\\u00"}'],
  ['include-widget-dynamic', 'Other', '{include $v}'],
] as const) {
  scene(`C/${spelling}/include-widget-target`, { role: 'ordinary', context: 'include-widget-target', spelling, boundary: 'eof-newline', state: 'multi-file' },
    files(inRole('ordinary', snippet), { 'target.tw': `:: ${target} [widget]\n{widget "greet"}hi{/widget}\n` }));
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
// The raw client boundary: every document the client sends starts with a BOM, so the first
// header of each (the story's own, and the declaring documents a rename edits) sits behind it.
// The client's coordinates include that code unit; the model must hold the same text.
const withBom = (fs: Files): Files => Object.fromEntries(Object.entries(fs).map(([n, t]) => [n, /\.tw$/.test(n) ? `\uFEFF${t}` : t]));
for (const [cname, snippet] of Object.entries(BOUNDARY_CORE)) {
  scene(`D/bom-first-header-raw-client/${cname}`, { role: 'ordinary', context: cname, spelling: 'plain', boundary: 'bom-first-header-raw-client', state: 'multi-file' }, withBom(files(`:: Start\n${snippet}\n`)));
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

// Family F: JavaScript payloads in {do} bodies. The body is executed as written, so a literal
// that spans lines is a value: formatting must not change it (see propFormatDoLiterals).
// Every body pushes its literals to `out`; the property evaluates it before and after formatting.
const DO_LITERALS: Record<string, string> = {
  'template-lf': 'const value = `a\nb`;\nout.push(value);',
  'template-leading-space-lines': 'out.push(`  a\n    b   \n\tc`);',
  'template-blank-lines': 'out.push(`a\n\n\nb`);',
  'template-nested-interpolation': 'out.push(`x ${ [1, 2].map(n => `<${n}\n  ${n}>`).join("") }\n   y`);',
  'template-brace-in-literal': 'out.push(`{\n  }`);',
  'template-html-lines': 'out.push(`\n<div>\n  x   y\n</div>\n`);',
  'template-after-comments': "// it's `not` a literal\n/* `no\n   more` */\nout.push(`a\n  b`);",
  'string-line-continuation': 'out.push("a\\\n   b");',
  'two-templates': 'out.push(`a\n b`, `c\n  d`);',
  'template-escaped-backtick': 'out.push(`a\\`\n  b`);',
  // regex literals and division before a multiline template (F66/regex-backtick-before-template)
  'regex-backtick-before-template': 'const re = /`/;\nconst value = `a\nb`;\nout.push(value, re.test("`"));',
  'regex-quote-before-template': 'const re = /"\'/;\nconst value = `a\n  b`;\nout.push(value, re.test("\'"));',
  'regex-class-slash-backtick': 'const re = /[/`]/;\nconst value = `a\n  b`;\nout.push(value, re.test("/"));',
  'regex-escaped-slash-backtick': 'const re = /\\/`/g;\nconst value = `a\n  b`;\nout.push(value, re.test("/`"));',
  'regex-in-call-and-interpolation': 'out.push("a-b".replace(/-/, "`"), `a\n  ${ /`/.test("`") }\n b`);',
  'division-before-template': 'const a = 6, b = 3;\nconst q = a / b;\nconst value = `a\n  b`;\nout.push(q, value, q / 2);',
  'division-after-paren-and-index': 'const a = [6];\nconst q = (a[0]) / 3 + a[0] / 3;\nout.push(q, `a\n  b`);',
  'regex-without-backtick': 'const re = /a b/;\nconst value = `a\n  b`;\nout.push(value, re.test("a b"));',
  'slash-comment-backtick': 'const x = 1; // /`/\nconst value = `a\n  b`;\nout.push(x, value);',
};
const DO_WRAPS: Record<string, (b: string) => string> = {
  container: b => `{do}\n${b}\n{/do}`,
  'indented-container': b => `{do}\n    ${b.replaceAll('\n', '\n    ')}\n{/do}`,
  inline: b => `{do}${b}{/do}`,
  'in-if': b => `{if $v}\n  {do}\n${b}\n  {/do}\n{/if}`,
  'in-element': b => `<div>\n{do}\n${b}\n{/do}\n</div>`,
  'in-button': b => `{button "go"}{do}${b}{/do}{/button}`,
  'with-prose': b => `before \n{do}\n${b}\n{/do}\n   after`,
};
const DO_EOLS: Record<string, string> = { lf: '\n', crlf: '\r\n' };
for (const [lname, body] of Object.entries(DO_LITERALS)) {
  for (const [wname, wrap] of Object.entries(DO_WRAPS)) {
    for (const [ename, eol] of Object.entries(DO_EOLS)) {
      scene(`F/do-${lname}/${wname}/${ename}`, { role: 'ordinary', context: `do body: ${lname}`, spelling: wname, boundary: ename === 'lf' ? 'eof-newline' : 'crlf', state: 'multi-file' },
        files(`:: Start\n${wrap(body)}\n`.replaceAll('\n', eol)));
    }
  }
}
// Controls: a single-line do body in a container, and a do body in a role passage
scene('F/do-control/single-line-in-container', { role: 'ordinary', context: 'do body: control', spelling: 'single-line', boundary: 'eof-newline', state: 'multi-file' },
  files(':: Start\n{if $v}\n{do}\nout.push(`a`);\n{/do}\n{/if}\n'));
scene('F/do-control/StoryInit', { role: 'StoryInit', context: 'do body: template', spelling: 'template-lf', boundary: 'eof-newline', state: 'multi-file' },
  files(inRole('StoryInit', '{do}\nout.push(`a\n  b`);\n{/do}')));

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

export const STATE_SUBSET = new Set([
  'A/ordinary/bracket-plain', 'A/ordinary/goto-double', 'A/ordinary/var-set', 'A/ordinary/widget-use',
  'A/widget/goto-double', 'A/StoryInit/link-macro-double', 'A/script/bracket-plain',
  'B/ordinary/bracket-in-attr', 'B/ordinary/var-property-path', 'B/ordinary/widget-block-pair',
  'D/crlf/bracket', 'D/astral-prefix/goto', 'D/incomplete-open-bracket/bracket', 'D/eof-no-newline/variable',
  'E/config-first/goto', 'E/single-file/bracket', 'E/js-source/goto', 'E/duplicate-passage/bracket',
  'E/two-stories/unicode-order', 'C/astral/bracket-plain', 'C/escaped-brackets-header/goto-double',
]);

// Cells that are named, and decided, but have nothing to execute. Each carries its justification in the results file.
export const NOT_APPLICABLE: Array<[string, Dims, string]> = [
  ['N/lone-cr-line-endings', { role: 'any', context: 'any', spelling: 'any', boundary: 'lone CR line endings', state: 'any', consumer: 'all' },
    'Twee 3 and Spindle\'s compiler know LF and CRLF only (the compiler normalizes CRLF to LF; a lone CR is an ordinary character in a header or macro). The server splits lines at LF everywhere, so a lone CR is not a line break to it, while the LSP position encoding counts it as one. Files with lone CR line endings are not Twee; boundary cells use LF, CRLF and mixed LF/CRLF.'],
  ['N/cli-document-lifecycle', { role: 'any', context: 'any', spelling: 'any', boundary: 'any', state: 'unsaved edit / add / remove / close document', consumer: 'CLI check/format' },
    'The CLI reads each file from disk once per run; there is no document lifecycle. The state differentials run in-process (state-order, state-incremental cells) and over JSON-RPC (I/entry-lsp-state/edit-close-reopen).'],
  ['N/mcp-entrypoint', { role: 'any', context: 'any', spelling: 'any', boundary: 'any', state: 'multi-file', consumer: 'MCP tools' },
    'The MCP tools call the same computeDiagnostics/formatDocument as the CLI (src/mcp/server.ts) and are covered end to end by test/integration/mcp.test.ts and test/integration/format-entrypoints.test.ts; the corpus compares the CLI and LSP entrypoints with the in-process consumers.'],
  ['N/spindle-version-state', { role: 'any', context: 'any', spelling: 'any', boundary: 'any', state: 'project format/version', consumer: 'all' },
    'The oracle is the installed Spindle (the devDependency, see spindleVersion), through its public @rohal12/spindle/tooling API. The minimum supported release is 0.59.20 (src/core/workspace/spindle-version.ts) and releases below it are reported, not emulated: the corpus is no longer run against other releases, and no expectation depends on the release.'],
  ['N/inlay-folding-symbols-actions', { role: 'any', context: 'any', spelling: 'any', boundary: 'any', state: 'any', consumer: 'inlay hints, folding ranges, document/workspace symbols, code actions' },
    'Not in the selected consumer set. Their own contracts live in test/unit/inlay-hints.test.ts, folding-range.test.ts, document-symbol.test.ts, workspace-symbol.test.ts, code-actions.test.ts and code-actions-config.test.ts (code actions consume the variable and passage references the corpus checks; hover is a corpus property).'],
  ['N/semantic-token-overlap-negotiation', { role: 'any', context: 'any', spelling: 'any', boundary: 'any', state: 'any', consumer: 'semantic tokens' },
    'The server never emits overlapping tokens (tokens property: sorted, non-overlapping on every scene), so there is no overlap behavior left to negotiate; the legend and delta encoding are covered by test/unit/semantic-tokens.test.ts.'],
];
