import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));

// Tests build into a temporary location with this; releases use dist/bin.js.
const outfile = process.env.SPINDLE_LSP_OUTFILE || 'dist/bin.js';

await build({
  entryPoints: ['src/bin.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile,
  external: [
    'prettier',
    // Loaded lazily by the play tools; bundling would break spindle/play's worker URLs.
    '@rohal12/spindle/play',
    'happy-dom',
    '@rohal12/twee-ts',
  ],
  define: {
    'SPINDLE_LSP_VERSION': JSON.stringify(pkg.version),
  },
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);' },
  sourcemap: true,
});
