import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveInputs, readFileContents } from '../core/workspace/file-inputs.js';

import { WorkspaceModel } from '../core/workspace/workspace-model.js';
import { computeDiagnostics } from '../plugins/diagnostics.js';
import type { DiagnosticOptions } from '../plugins/diagnostics.js';
import { loadConfigFromDisk, loadConfigFile, findConfigRoot } from '../core/workspace/config-loader.js';
import type { SpindleProjectConfig } from '../core/workspace/config-loader.js';
import { addProjectMacroSources, commonDirectory } from '../core/workspace/macro-sources.js';
import { findStoryFormat, skippedFormatNote } from '../core/workspace/story-format.js';
import type { Diagnostic } from '../core/types.js';
import { formatPretty } from './reporters/pretty.js';
import { formatJson } from './reporters/json.js';
import { formatSarif } from './reporters/sarif.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CheckOptions {
  format: 'pretty' | 'json' | 'sarif';
  severity: 'error' | 'warning' | 'info' | 'hint' | null;
  configPath: string | null;
  maxLineLength: number | null;
  patterns: string[];
}

function parseArgs(args: string[]): CheckOptions {
  const options: CheckOptions = {
    format: 'pretty',
    severity: null,
    configPath: null,
    maxLineLength: null,
    patterns: [],
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--format' && i + 1 < args.length) {
      const fmt = args[i + 1];
      if (fmt === 'pretty' || fmt === 'json' || fmt === 'sarif') {
        options.format = fmt;
      }
      i += 2;
    } else if (arg.startsWith('--format=')) {
      const fmt = arg.slice('--format='.length);
      if (fmt === 'pretty' || fmt === 'json' || fmt === 'sarif') {
        options.format = fmt;
      }
      i++;
    } else if (arg === '--severity' && i + 1 < args.length) {
      const sev = args[i + 1];
      if (sev === 'error' || sev === 'warning' || sev === 'info' || sev === 'hint') {
        options.severity = sev;
      }
      i += 2;
    } else if (arg.startsWith('--severity=')) {
      const sev = arg.slice('--severity='.length);
      if (sev === 'error' || sev === 'warning' || sev === 'info' || sev === 'hint') {
        options.severity = sev;
      }
      i++;
    } else if (arg === '--config' && i + 1 < args.length) {
      options.configPath = args[i + 1];
      i += 2;
    } else if (arg.startsWith('--config=')) {
      options.configPath = arg.slice('--config='.length);
      i++;
    } else if (arg === '--max-line-length' && i + 1 < args.length) {
      const n = parseInt(args[i + 1], 10);
      if (!isNaN(n) && n > 0) options.maxLineLength = n;
      i += 2;
    } else if (arg.startsWith('--max-line-length=')) {
      const n = parseInt(arg.slice('--max-line-length='.length), 10);
      if (!isNaN(n) && n > 0) options.maxLineLength = n;
      i++;
    } else if (!arg.startsWith('--')) {
      options.patterns.push(arg);
      i++;
    } else {
      // Skip unknown flags
      i++;
    }
  }

  if (options.patterns.length === 0) {
    options.patterns = ['**/*.{tw,twee}'];
  }

  return options;
}

// ---------------------------------------------------------------------------
// Severity filtering
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = ['hint', 'info', 'warning', 'error'] as const;

function filterBySeverity(
  diagnostics: Diagnostic[],
  minSeverity: 'error' | 'warning' | 'info' | 'hint',
): Diagnostic[] {
  const minIdx = SEVERITY_ORDER.indexOf(minSeverity);
  return diagnostics.filter(d => {
    const idx = SEVERITY_ORDER.indexOf(d.severity);
    return idx >= minIdx;
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runCheck(args: string[]): Promise<number> {
  const options = parseArgs(args);

  // Determine workspace root (cwd)
  const cwd = process.cwd();

  // An explicit --config path is loaded exactly as given. Fail early (before
  // globbing) if it cannot be read or parsed.
  let explicitConfig: SpindleProjectConfig | null = null;
  if (options.configPath) {
    try {
      explicitConfig = loadConfigFile(resolve(cwd, options.configPath));
    } catch (err: unknown) {
      console.error(`spindle-lsp check: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  let uniqueFiles: string[];
  let contents: Map<string, string>;
  try {
    uniqueFiles = await resolveInputs(options.patterns, cwd);
    contents = readFileContents(uniqueFiles);
  } catch (error) {
    console.error(`spindle-lsp check: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  if (uniqueFiles.length === 0) {
    if (options.format === 'pretty') {
      console.log('No files found');
    } else if (options.format === 'json') {
      console.log(JSON.stringify({ files: [] }, null, 2));
    } else {
      console.log(formatSarif([]));
    }
    return 0;
  }

  // Load project config — unless given explicitly, search from the common
  // ancestor of matched files, walking up to find the config file (covers
  // running from a different cwd)
  // Common directory of all matched files: the project's builtin macros
  // (its installed @rohal12/spindle) and its config are found from here
  const commonDir = commonDirectory(uniqueFiles);

  let projectConfig: SpindleProjectConfig;
  if (explicitConfig) {
    projectConfig = explicitConfig;
  } else {
    const configRoot = findConfigRoot(commonDir);
    try {
      projectConfig = loadConfigFromDisk(configRoot);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  // Load files
  const fileContents = new Map([...contents].map(([path, text]) => [pathToFileURL(path).toString(), text]));

  // Spindle's rules do not apply to a story in another format: report
  // nothing (the reporters still print their empty output) and say why.
  const storyFormat = await findStoryFormat(fileContents.values(), commonDir);
  if (!storyFormat.isSpindle) {
    console.error(skippedFormatNote(storyFormat));
    report(options.format, []);
    return 0;
  }

  // Create the workspace. JS/TS files defining custom macros
  // (Story.defineMacro) are loaded for discovery only — they are not
  // checked. Search the project containing the checked files (independent
  // of the cwd).
  const workspace = new WorkspaceModel({ workspaceRoot: commonDir });
  // Configure macros before initialization builds markup and usage indices.
  if (Object.keys(projectConfig.macros).length > 0) {
    workspace.macros.loadConfig(projectConfig.macros);
  }
  const workspaceContents = new Map(fileContents);
  await addProjectMacroSources(workspaceContents, commonDir);
  workspace.initialize(workspaceContents);

  // Compute diagnostics for each file
  const diagOptions: DiagnosticOptions = {};
  if (options.maxLineLength !== null) {
    diagOptions.maxLineLength = options.maxLineLength;
  }

  const allResults: Array<{ uri: string; diagnostics: Diagnostic[] }> = [];
  let hasErrors = false;

  for (const uri of fileContents.keys()) {
    let diags = computeDiagnostics(uri, workspace, diagOptions);

    // Filter by severity if specified
    if (options.severity) {
      diags = filterBySeverity(diags, options.severity);
    }

    if (diags.length > 0) {
      allResults.push({ uri, diagnostics: diags });
      if (diags.some(d => d.severity === 'error')) {
        hasErrors = true;
      }
    }
  }

  report(options.format, allResults);

  // Cleanup
  workspace.dispose();

  return hasErrors ? 1 : 0;
}

/** Print the results with the chosen reporter. */
function report(
  format: CheckOptions['format'],
  results: Array<{ uri: string; diagnostics: Diagnostic[] }>,
): void {
  switch (format) {
    case 'pretty':
      console.log(formatPretty(results));
      break;
    case 'json':
      console.log(formatJson(results));
      break;
    case 'sarif':
      console.log(formatSarif(results));
      break;
  }
}
