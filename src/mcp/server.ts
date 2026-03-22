import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { glob } from 'glob';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { WorkspaceModel } from '../core/workspace/workspace-model.js';
import { loadConfigFromDisk, findConfigFile } from '../core/workspace/config-loader.js';
import { computeDiagnostics } from '../plugins/diagnostics.js';
import { formatDocument } from '../plugins/format.js';
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
function findConfigRoot(files: string[]): string {
  const dirs = files.map(f => resolve(f, '..'));
  let configRoot = dirs.reduce((a, b) => {
    while (!b.startsWith(a)) a = resolve(a, '..');
    return a;
  });

  let search = configRoot;
  for (let i = 0; i < 10; i++) {
    if (findConfigFile(search)) { configRoot = search; break; }
    const parent = resolve(search, '..');
    if (parent === search) break;
    search = parent;
  }
  return configRoot;
}

/**
 * Create a workspace model loaded with the given files and project config.
 */
function createWorkspace(files: string[]): WorkspaceModel {
  const configRoot = findConfigRoot(files);
  const projectConfig = loadConfigFromDisk(configRoot);

  const workspace = new WorkspaceModel();
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

  workspace.initialize(fileContents);

  if (Object.keys(projectConfig.macros).length > 0) {
    workspace.macros.loadSupplements(projectConfig.macros);
  }

  return workspace;
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
      const cwd = process.cwd();
      const files = await resolveFiles(args.path, cwd);

      if (files.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify([], null, 2) }],
        };
      }

      const workspace = createWorkspace(files);

      try {
        const results: Array<{
          file: string;
          line: number;
          column: number;
          severity: string;
          code: string;
          message: string;
        }> = [];

        for (const [uri] of workspace.documents.getUris().map(u => [u] as const)) {
          let diags = computeDiagnostics(uri, workspace);

          if (args.severity) {
            diags = filterBySeverity(diags, args.severity);
          }

          const filePath = fileURLToPath(uri);
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

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
        };
      } finally {
        workspace.dispose();
      }
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
      const cwd = process.cwd();
      const files = await resolveFiles(args.path, cwd);

      let formatted = 0;
      let unchanged = 0;
      const changedFiles: string[] = [];

      for (const filePath of files) {
        try {
          const text = readFileSync(filePath, 'utf-8');
          const result = formatDocument(text);

          if (result !== text) {
            writeFileSync(filePath, result, 'utf-8');
            formatted++;
            const relativePath = filePath.startsWith(cwd)
              ? filePath.slice(cwd.length + 1)
              : filePath;
            changedFiles.push(relativePath);
          } else {
            unchanged++;
          }
        } catch {
          // Skip unreadable/unwritable files
        }
      }

      const output = { formatted, unchanged, files: changedFiles };
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
      const cwd = process.cwd();
      const files = await resolveFiles(args.path, cwd);

      const needsFormatting: string[] = [];
      const alreadyFormatted: string[] = [];

      for (const filePath of files) {
        try {
          const text = readFileSync(filePath, 'utf-8');
          const result = formatDocument(text);

          const relativePath = filePath.startsWith(cwd)
            ? filePath.slice(cwd.length + 1)
            : filePath;

          if (result !== text) {
            needsFormatting.push(relativePath);
          } else {
            alreadyFormatted.push(relativePath);
          }
        } catch {
          // Skip unreadable files
        }
      }

      const output = { needsFormatting, alreadyFormatted };
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
