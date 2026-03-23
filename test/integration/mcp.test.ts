import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync as readFixture } from 'node:fs';

import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { formatDocument } from '../../src/plugins/format.js';

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');

// ---------------------------------------------------------------------------
// We test the MCP tool logic directly (same code paths as the MCP handlers)
// rather than spinning up a full MCP transport, since the transport layer is
// tested by the SDK itself.
// ---------------------------------------------------------------------------

/**
 * Helpers that mirror the MCP server's tool implementations.
 */

function createWorkspace(files: string[]): WorkspaceModel {
  const workspace = new WorkspaceModel();
  const fileContents = new Map<string, string>();

  for (const filePath of files) {
    try {
      const text = readFixture(filePath, 'utf-8');
      const uri = pathToFileURL(filePath).toString();
      fileContents.set(uri, text);
    } catch {
      // skip
    }
  }

  workspace.initialize(fileContents);
  return workspace;
}

describe('MCP spindle_check', () => {
  it('returns diagnostics for error fixture', () => {
    const errorFile = join(fixturesDir, 'errors.tw');
    const workspace = createWorkspace([errorFile]);

    try {
      const uri = pathToFileURL(errorFile).toString();
      const diags = computeDiagnostics(uri, workspace);

      expect(diags.length).toBeGreaterThan(0);

      // Verify structured output matches expected schema
      const results = diags.map(d => ({
        file: 'errors.tw',
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        severity: d.severity,
        code: d.code,
        message: d.message,
      }));

      expect(results[0]).toHaveProperty('file');
      expect(results[0]).toHaveProperty('line');
      expect(results[0]).toHaveProperty('column');
      expect(results[0]).toHaveProperty('severity');
      expect(results[0]).toHaveProperty('code');
      expect(results[0]).toHaveProperty('message');

      // Should detect the malformed container (missing /if)
      const containerError = results.find(r => r.code === 'SP101');
      expect(containerError).toBeDefined();
      expect(containerError!.message).toContain('Malformed container');
    } finally {
      workspace.dispose();
    }
  });

  it('returns empty array for valid story', () => {
    const validFile = join(fixturesDir, 'valid-story.tw');
    const workspace = createWorkspace([validFile]);

    try {
      const uri = pathToFileURL(validFile).toString();
      const diags = computeDiagnostics(uri, workspace);
      expect(diags.length).toBe(0);
    } finally {
      workspace.dispose();
    }
  });

  it('filters by severity', () => {
    const errorFile = join(fixturesDir, 'errors.tw');
    const workspace = createWorkspace([errorFile]);

    try {
      const uri = pathToFileURL(errorFile).toString();
      const allDiags = computeDiagnostics(uri, workspace);

      // Filter to errors only
      const SEVERITY_ORDER = ['hint', 'info', 'warning', 'error'] as const;
      const minIdx = SEVERITY_ORDER.indexOf('error');
      const errorOnly = allDiags.filter(d => {
        const idx = SEVERITY_ORDER.indexOf(d.severity);
        return idx >= minIdx;
      });

      expect(errorOnly.length).toBeLessThanOrEqual(allDiags.length);
      for (const d of errorOnly) {
        expect(d.severity).toBe('error');
      }
    } finally {
      workspace.dispose();
    }
  });
});

describe('MCP spindle_format_check', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'spindle-mcp-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('identifies unformatted files', async () => {
    // Write an unformatted file
    const unformattedPath = join(tmpDir, 'unformatted.tw');
    writeFileSync(unformattedPath, ':: Start\n{if $x}\n{set $y = 1}\n{/if}');

    // Write a formatted file
    const formattedPath = join(tmpDir, 'formatted.tw');
    writeFileSync(formattedPath, ':: Start\n{if $x}\n  {set $y = 1}\n{/if}\n');

    const needsFormatting: string[] = [];
    const alreadyFormatted: string[] = [];

    for (const filePath of [unformattedPath, formattedPath]) {
      const text = readFileSync(filePath, 'utf-8');
      const result = await formatDocument(text);
      if (result !== text) {
        needsFormatting.push(filePath);
      } else {
        alreadyFormatted.push(filePath);
      }
    }

    expect(needsFormatting).toHaveLength(1);
    expect(needsFormatting[0]).toContain('unformatted.tw');
    expect(alreadyFormatted).toHaveLength(1);
    expect(alreadyFormatted[0]).toContain('formatted.tw');
  });

  it('reports all files as formatted when they are', async () => {
    const path1 = join(tmpDir, 'a.tw');
    const path2 = join(tmpDir, 'b.tw');
    writeFileSync(path1, ':: Start\nHello\n');
    writeFileSync(path2, ':: Other\nWorld\n');

    const needsFormatting: string[] = [];
    const alreadyFormatted: string[] = [];

    for (const filePath of [path1, path2]) {
      const text = readFileSync(filePath, 'utf-8');
      const result = await formatDocument(text);
      if (result !== text) {
        needsFormatting.push(filePath);
      } else {
        alreadyFormatted.push(filePath);
      }
    }

    expect(needsFormatting).toHaveLength(0);
    expect(alreadyFormatted).toHaveLength(2);
  });
});

describe('MCP spindle_format', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'spindle-mcp-fmt-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('formats files in place and returns summary', async () => {
    const path1 = join(tmpDir, 'needs-format.tw');
    const path2 = join(tmpDir, 'already-ok.tw');
    writeFileSync(path1, ':: Start\n{if $x}\n{set $y = 1}\n{/if}');
    writeFileSync(path2, ':: Start\nHello\n');

    let formatted = 0;
    let unchanged = 0;
    const changedFiles: string[] = [];

    for (const filePath of [path1, path2]) {
      const text = readFileSync(filePath, 'utf-8');
      const result = await formatDocument(text);

      if (result !== text) {
        writeFileSync(filePath, result, 'utf-8');
        formatted++;
        changedFiles.push(filePath);
      } else {
        unchanged++;
      }
    }

    expect(formatted).toBe(1);
    expect(unchanged).toBe(1);
    expect(changedFiles).toHaveLength(1);
    expect(changedFiles[0]).toContain('needs-format.tw');

    // Verify the file was actually modified
    const updatedContent = readFileSync(path1, 'utf-8');
    expect(updatedContent).toContain('  {set $y = 1}');
    expect(updatedContent.endsWith('\n')).toBe(true);
  });

  it('returns zero formatted when all files are already formatted', async () => {
    const filePath = join(tmpDir, 'ok.tw');
    writeFileSync(filePath, ':: Start\n{if $x}\n  {set $y = 1}\n{/if}\n');

    const text = readFileSync(filePath, 'utf-8');
    const result = await formatDocument(text);

    expect(result).toBe(text);
  });
});
