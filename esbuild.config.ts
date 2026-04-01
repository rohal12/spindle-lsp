import { build } from 'esbuild';

await build({
  entryPoints: ['src/bin.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/bin.js',
  external: [
    'prettier',
  ],
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
});
