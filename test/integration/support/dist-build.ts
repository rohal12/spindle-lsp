import { mkdtempSync, symlinkSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface DistBuild {
  /** Absolute path of the built executable. */
  executable: string;
  /** Delete the build. */
  dispose(): void;
}

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Build the executable with the project's own `npm run build` (the script
 * that produces `dist/bin.js` for publishing), into a temporary directory so
 * tests never touch or depend on a prior `dist/`.
 *
 * The directory is laid out like the published package: a `package.json`
 * (the bundle is an ES module) and `node_modules` for the one external
 * dependency (`prettier`) and the Spindle runtime lookups.
 */
export function buildDist(): DistBuild {
  const directory = mkdtempSync(join(tmpdir(), 'spindle-lsp-dist-'));
  const executable = join(directory, 'bin.js');
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n');
  symlinkSync(join(repoRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
  execFileSync(npm, ['run', 'build'], {
    cwd: repoRoot,
    env: { ...process.env, SPINDLE_LSP_OUTFILE: executable },
    stdio: 'pipe',
  });
  if (!existsSync(executable)) throw new Error(`npm run build did not produce ${executable}`);
  return { executable, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}
