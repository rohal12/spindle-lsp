import { build } from 'esbuild';

await build({
  entryPoints: ['src/bin.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/bin.js',
  external: [
    '@rohal12/spindle',
    'vscode-languageserver',
    'vscode-languageserver-textdocument',
    'vscode-languageserver-protocol',
    'glob',
    'yaml',
    '@modelcontextprotocol/sdk',
    'zod',
  ],
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
});
