import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { glob } from 'glob';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { WorkspaceModel } from '../core/workspace/workspace-model.js';
import { loadConfigFromDisk, findConfigFile } from '../core/workspace/config-loader.js';
import { addProjectMacroSources, commonDirectory } from '../core/workspace/macro-sources.js';
import { computeDiagnostics } from '../plugins/diagnostics.js';
import { formatDocument } from '../plugins/format.js';
import { findStoryFormat, skippedFormatNote } from '../core/workspace/story-format.js';
import type { Diagnostic } from '../core/types.js';

// ---------------------------------------------------------------------------
// Helpers
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

/**
 * Resolve glob patterns to absolute file paths.
 */
async function resolveFiles(pattern: string, cwd: string): Promise<string[]> {
  const matches = await glob(pattern, {
    cwd,
    absolute: true,
    nodir: true,
  });
  return [...new Set(matches)];
}

/**
 * Find the config root by walking up from the common directory of matched files.
 */
function findConfigRoot(commonDir: string): string {
  let configRoot = commonDir;
  let search = configRoot;
  for (let i = 0; i < 10; i++) {
    if (findConfigFile(search)) { configRoot = search; break; }
    const parent = resolve(search, '..');
    if (parent === search) break;
    search = parent;
  }
  return configRoot;
}

/** Read the given files (file URI to text), skipping unreadable ones. */
function readFiles(files: string[]): Map<string, string> {
  const fileContents = new Map<string, string>();
  for (const filePath of files) {
    try {
      const text = readFileSync(filePath, 'utf-8');
      const uri = pathToFileURL(filePath).toString();
      fileContents.set(uri, text);
    } catch {
      // Skip unreadable files
    }
  }
  return fileContents;
}

/**
 * Why the files of a story in another format are skipped, or undefined for
 * a Spindle story. The format comes from the StoryData among the files, or
 * else from the project they belong to.
 */
async function skippedReason(
  fileContents: Map<string, string>,
  files: string[],
): Promise<string | undefined> {
  const format = await findStoryFormat(fileContents.values(), commonDirectory(files));
  return format.isSpindle ? undefined : skippedFormatNote(format);
}

/**
 * Create a workspace model loaded with the given files (`fileContents`),
 * the project's JS/TS macro sources (for macro discovery) and the project
 * config.
 */
async function createWorkspace(
  files: string[],
  fileContents: Map<string, string>,
): Promise<WorkspaceModel> {
  const commonDir = commonDirectory(files);
  const configRoot = findConfigRoot(commonDir);
  const projectConfig = loadConfigFromDisk(configRoot);

  const workspace = new WorkspaceModel({ workspaceRoot: configRoot });
  fileContents = new Map(fileContents);

  await addProjectMacroSources(fileContents, commonDir);
  workspace.initialize(fileContents);

  if (Object.keys(projectConfig.macros).length > 0) {
    workspace.macros.loadConfig(projectConfig.macros);
  }

  return workspace;
}

/** A diagnostic as returned by the `spindle_check` tool. */
export interface CheckResult {
  file: string;
  line: number;
  column: number;
  severity: string;
  code: string;
  message: string;
}

/**
 * Run diagnostics on the files matching `pattern` (the `spindle_check` tool).
 * File paths in the results are relative to `cwd` when inside it.
 */
export async function checkFiles(
  pattern: string,
  severity?: 'error' | 'warning' | 'info' | 'hint',
  cwd: string = process.cwd(),
): Promise<CheckResult[]> {
  return (await checkProject(pattern, severity, cwd)).results;
}

/**
 * {@link checkFiles}, also saying why the files were skipped (`skipped`)
 * when they belong to a story in another format: then there are no results.
 */
export async function checkProject(
  pattern: string,
  severity?: 'error' | 'warning' | 'info' | 'hint',
  cwd: string = process.cwd(),
): Promise<{ results: CheckResult[]; skipped?: string }> {
  const files = await resolveFiles(pattern, cwd);
  if (files.length === 0) return { results: [] };

  const fileContents = readFiles(files);
  const skipped = await skippedReason(fileContents, files);
  if (skipped) return { results: [], skipped };

  const workspace = await createWorkspace(files, fileContents);

  try {
    const results: CheckResult[] = [];

    for (const filePath of files) {
      const uri = pathToFileURL(filePath).toString();
      // Unreadable files were skipped
      if (!workspace.documents.has(uri)) continue;
      let diags = computeDiagnostics(uri, workspace);

      if (severity) {
        diags = filterBySeverity(diags, severity);
      }

      const relativePath = filePath.startsWith(cwd)
        ? filePath.slice(cwd.length + 1)
        : filePath;

      for (const d of diags) {
        results.push({
          file: relativePath,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: d.severity,
          code: d.code,
          message: d.message,
        });
      }
    }

    return { results };
  } finally {
    workspace.dispose();
  }
}

/** Path of `filePath` relative to `cwd` when inside it. */
function relativeTo(cwd: string, filePath: string): string {
  return filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
}

/** Result of the `spindle_format` tool. */
export interface FormatResult {
  formatted: number;
  unchanged: number;
  files: string[];
  /** Why nothing was formatted: the files belong to a story in another format. */
  skipped?: string;
}

/**
 * Format the files matching `pattern` in place (the `spindle_format` tool),
 * unless they belong to a story in another format.
 */
export async function formatFiles(pattern: string, cwd: string = process.cwd()): Promise<FormatResult> {
  const files = await resolveFiles(pattern, cwd);
  const contents = readFiles(files);
  const skipped = files.length > 0 ? await skippedReason(contents, files) : undefined;
  if (skipped) return { formatted: 0, unchanged: 0, files: [], skipped };

  let formatted = 0;
  let unchanged = 0;
  const changedFiles: string[] = [];

  for (const filePath of files) {
    const text = contents.get(pathToFileURL(filePath).toString());
    if (text === undefined) continue;
    try {
      const result = await formatDocument(text);

      if (result !== text) {
        writeFileSync(filePath, result, 'utf-8');
        formatted++;
        changedFiles.push(relativeTo(cwd, filePath));
      } else {
        unchanged++;
      }
    } catch {
      // Skip unwritable files
    }
  }

  return { formatted, unchanged, files: changedFiles };
}

/** Result of the `spindle_format_check` tool. */
export interface FormatCheckResult {
  needsFormatting: string[];
  alreadyFormatted: string[];
  /** Why nothing was checked: the files belong to a story in another format. */
  skipped?: string;
}

/**
 * List which files matching `pattern` the formatter would change (the
 * `spindle_format_check` tool), unless they belong to a story in another
 * format.
 */
export async function checkFormatting(
  pattern: string,
  cwd: string = process.cwd(),
): Promise<FormatCheckResult> {
  const files = await resolveFiles(pattern, cwd);
  const contents = readFiles(files);
  const skipped = files.length > 0 ? await skippedReason(contents, files) : undefined;
  if (skipped) return { needsFormatting: [], alreadyFormatted: [], skipped };

  const needsFormatting: string[] = [];
  const alreadyFormatted: string[] = [];

  for (const filePath of files) {
    const text = contents.get(pathToFileURL(filePath).toString());
    if (text === undefined) continue;
    try {
      const result = await formatDocument(text);
      (result !== text ? needsFormatting : alreadyFormatted).push(relativeTo(cwd, filePath));
    } catch {
      // Skip files the formatter fails on
    }
  }

  return { needsFormatting, alreadyFormatted };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'spindle-lsp',
    version: '0.3.5',
  });

  // -------------------------------------------------------------------------
  // spindle_check
  // -------------------------------------------------------------------------

  server.tool(
    'spindle_check',
    'Run diagnostics on .tw/.twee files. Returns structured diagnostic results.',
    {
      path: z.string().default('**/*.{tw,twee}').describe('Glob pattern or directory to check'),
      severity: z.enum(['error', 'warning', 'info', 'hint']).optional().describe('Minimum severity to include'),
    },
    async (args) => {
      const { results, skipped } = await checkProject(args.path, args.severity);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(results, null, 2) },
          ...(skipped ? [{ type: 'text' as const, text: skipped }] : []),
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // spindle_format
  // -------------------------------------------------------------------------

  server.tool(
    'spindle_format',
    'Format .tw/.twee files in place.',
    {
      path: z.string().default('**/*.{tw,twee}').describe('Glob pattern or directory to format'),
    },
    async (args) => {
      const output = await formatFiles(args.path);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // spindle_format_check
  // -------------------------------------------------------------------------

  server.tool(
    'spindle_format_check',
    'Check formatting without modifying files. Returns list of files that need formatting.',
    {
      path: z.string().default('**/*.{tw,twee}').describe('Glob pattern or directory to check'),
    },
    async (args) => {
      const output = await checkFormatting(args.path);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Start transport
  // -------------------------------------------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
