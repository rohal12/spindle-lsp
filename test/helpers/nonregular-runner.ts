import { execFileSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { resolveFiles, readFileContents } from '../../src/core/workspace/file-inputs.js';
import { findMacroSourceFiles } from '../../src/core/workspace/macro-sources.js';
import { runCheck } from '../../src/cli/check.js';
import { checkFiles } from '../../src/mcp/server.js';

const [mode, directory, name = '.'] = process.argv.slice(2);
switch (mode) {
  case 'discover':
    console.log(JSON.stringify({
      stories: (await resolveFiles('.', directory)).map(path => basename(path)),
      macros: (await findMacroSourceFiles(directory)).map(path => basename(path)),
    }));
    break;
  case 'cli':
    process.exitCode = await runCheck(['--format', 'json', join(directory, name)]);
    break;
  case 'mcp':
    console.log(JSON.stringify(await checkFiles(join(directory, name), directory)));
    break;
  case 'replace': {
    const files = await resolveFiles(name, directory);
    unlinkSync(files[0]);
    execFileSync('mkfifo', [files[0]]);
    try {
      readFileContents(files);
      throw new Error('Accepted a FIFO in place of a discovered source');
    } catch (error) {
      console.log((error as Error).message);
    }
    break;
  }
}
