import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { glob } from 'glob';

import { WorkspaceModel } from '../core/workspace/workspace-model.js';
import { computeDiagnostics } from '../plugins/diagnostics.js';
import { loadConfigFromDisk, findConfigFile } from '../core/workspace/config-loader.js';
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
  patterns: string[];
}

function parseArgs(args: string[]): CheckOptions {
  const options: CheckOptions = {
    format: 'pretty',
    severity: null,
    configPath: null,
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

  // Resolve files via glob
  const files: string[] = [];
  for (const pattern of options.patterns) {
    const matches = await glob(pattern, {
      cwd,
      absolute: true,
      nodir: true,
    });
    files.push(...matches);
  }

  // Deduplicate
  const uniqueFiles = [...new Set(files)];

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

  // Load project config — search from the common ancestor of matched files,
  // walking up to find the config file (covers running from a different cwd)
  let configRoot: string;
  if (options.configPath) {
    configRoot = resolve(cwd, options.configPath, '..');
  } else {
    // Find the common directory of all matched files
    const dirs = uniqueFiles.map(f => resolve(f, '..'));
    configRoot = dirs.reduce((a, b) => {
      while (!b.startsWith(a)) a = resolve(a, '..');
      return a;
    });
    // Walk up from common dir to find config (max 10 levels)
    let search = configRoot;
    for (let i = 0; i < 10; i++) {
      if (findConfigFile(search)) { configRoot = search; break; }
      const parent = resolve(search, '..');
      if (parent === search) break;
      search = parent;
    }
  }
  const projectConfig = loadConfigFromDisk(configRoot);

  // Create workspace and load files
  const workspace = new WorkspaceModel();
  const fileContents = new Map<string, string>();
  for (const filePath of uniqueFiles) {
    try {
      const text = readFileSync(filePath, 'utf-8');
      const uri = pathToFileURL(filePath).toString();
      fileContents.set(uri, text);
    } catch {
      // Skip unreadable files
    }
  }
  workspace.initialize(fileContents);

  // Load user macros from config
  if (Object.keys(projectConfig.macros).length > 0) {
    workspace.macros.loadSupplements(projectConfig.macros);
  }

  // Compute diagnostics for each file
  const allResults: Array<{ uri: string; diagnostics: Diagnostic[] }> = [];
  let hasErrors = false;

  for (const uri of fileContents.keys()) {
    let diags = computeDiagnostics(uri, workspace);

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

  // Format output
  switch (options.format) {
    case 'pretty':
      console.log(formatPretty(allResults));
      break;
    case 'json':
      console.log(formatJson(allResults));
      break;
    case 'sarif':
      console.log(formatSarif(allResults));
      break;
  }

  // Cleanup
  workspace.dispose();

  return hasErrors ? 1 : 0;
}
