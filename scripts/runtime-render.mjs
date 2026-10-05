#!/usr/bin/env node
// Render passage markup with a real published @rohal12/spindle, in a DOM, and
// print the HTML. This is the ground truth for what the runtime interpolates
// (see test/unit/link-interpolation.test.ts and
// docs/reviews/2026-10-06-convergence-fixes.md): it runs the release's own
// tokenize -> buildAST -> renderNodes path, with its builtin macros.
//
//   node scripts/runtime-render.mjs <spindle-version> [markup ...]
//   node scripts/runtime-render.mjs 0.51.3 '[[Take {$item}->T]]'
//
// Without markup it renders the link, button and attribute cases the review
// relies on. Variables: item = "Sword", n = 3. The release, jsdom and esbuild
// are installed under $TMPDIR/spindle-render/<version> (network needed once);
// nothing in the repository is touched.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/runtime-render.mjs <spindle-version> [markup ...]');
  process.exit(2);
}
const dir = join(process.env.TMPDIR || tmpdir(), 'spindle-render', version);
mkdirSync(dir, { recursive: true });
if (!existsSync(join(dir, 'node_modules', 'jsdom'))) {
  writeFileSync(join(dir, 'package.json'), '{"name":"render","private":true}\n');
  execFileSync('npm', ['install', '--silent', `@rohal12/spindle@${version}`, 'jsdom', 'esbuild'], { cwd: dir, stdio: 'inherit' });
}

writeFileSync(join(dir, 'entry.tsx'), `
import { render } from 'preact';
import { tokenize } from '@rohal12/spindle/src/markup/tokenizer';
import { buildAST } from '@rohal12/spindle/src/markup/ast';
import { renderNodes } from '@rohal12/spindle/src/markup/render';
import { useStoryStore } from '@rohal12/spindle/src/store';
import '@rohal12/spindle/src/macros/register-builtins';

export function html(source: string, vars: Record<string, unknown>): string {
  useStoryStore.setState({ variables: vars, temporary: {}, currentPassage: 'Start' } as any);
  const container = document.createElement('div');
  render(<div>{renderNodes(buildAST(tokenize(source)))}</div>, container);
  return container.innerHTML;
}
`);

const { JSDOM } = await import(pathToFileURL(join(dir, 'node_modules/jsdom/lib/api.js')).href);
const { build } = await import(pathToFileURL(join(dir, 'node_modules/esbuild/lib/main.js')).href);
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'navigator', 'localStorage', 'sessionStorage',
  'requestAnimationFrame', 'getComputedStyle', 'Event', 'CustomEvent', 'MutationObserver', 'DOMParser', 'SVGElement',
  'Text', 'history', 'location']) {
  try { globalThis[key] = dom.window[key]; } catch { Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true }); }
}
await build({
  entryPoints: [join(dir, 'entry.tsx')], bundle: true, format: 'esm', platform: 'node', outfile: join(dir, 'out.mjs'),
  absWorkingDir: dir, jsx: 'automatic', jsxImportSource: 'preact', loader: { '.css': 'text' }, logLevel: 'error',
  nodePaths: [join(dir, 'node_modules')],
  // the package's exports map hides src/, which the render path needs
  alias: { react: 'preact/compat', 'react-dom': 'preact/compat', '@rohal12/spindle': join(dir, 'node_modules/@rohal12/spindle') },
  banner: { js: 'import {createRequire as cr} from "node:module"; const require = cr(import.meta.url);' },
});
const { html } = await import(pathToFileURL(join(dir, 'out.mjs')).href);

const cases = process.argv.slice(3).length > 0 ? process.argv.slice(3) : [
  '[[Take {$item}->T]]',
  '[[Go->T{$n}]]',
  '[[Take {$item}]]',
  '[[Take|T{$n}]]',
  '[[.c{$item} Go->T]]',
  '{link "Take {$item}" "T"}x{/link}',
  '{button "Take {$item}"}x{/button}',
  '{dialog "Open {$item}"}Passage{/dialog}',
  '{print "a {$item}"}',
  '{set _s = "a {$item}"}{_s}',
  '{print `a ${$item}`}',
  '<a title="{$item}" href="{$item}">x</a>',
];
for (const source of cases) {
  let result;
  try { result = html(source, { item: 'Sword', n: 3 }); } catch (error) { result = `ERROR ${error.message}`; }
  console.log(JSON.stringify(source), '=>', result);
}
