import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
  type Diagnostic as LspDiagnostic,
} from 'vscode-languageserver/node.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { getCompletions } from '../../src/plugins/completions.js';
import { findReferences, findPassageReferences } from '../../src/plugins/references.js';
import { computeRename, prepareRename } from '../../src/plugins/rename.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { getHoverInfo } from '../../src/plugins/hover.js';
import { runCheck } from '../../src/cli/check.js';

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8');
}

/** Build a full workspace from multiple fixture-like files. */
function buildWorkspace(
  files: Record<string, string>,
): WorkspaceModel {
  const model = new WorkspaceModel();
  const contents = new Map<string, string>();
  for (const [name, text] of Object.entries(files)) {
    contents.set(`file:///${name}`, text);
  }
  model.initialize(contents);
  return model;
}

// Helper: capture stdout during a function call
async function captureStdout(fn: () => Promise<number>): Promise<{ exitCode: number; output: string }> {
  const writes: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    writes.push(args.map(String).join(' '));
  };
  try {
    const exitCode = await fn();
    return { exitCode, output: writes.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

// =========================================================================
// Full-workspace integration tests
// =========================================================================

describe('Integration: Full workspace workflow', () => {
  let workspace: WorkspaceModel;

  const validStory = readFixture('valid-story.tw');
  const errorsFile = readFixture('errors.tw');
  const widgetsFile = readFixture('widgets.tw');
  const variablesFile = readFixture('variables.tw');

  afterEach(() => {
    workspace?.dispose();
  });

  // -----------------------------------------------------------------------
  // 1. Diagnostics: error file vs valid file
  // -----------------------------------------------------------------------

  it('produces diagnostics for error file but not for valid file in same workspace', () => {
    workspace = buildWorkspace({
      'valid-story.tw': validStory,
      'errors.tw': errorsFile,
    });

    const validDiags = computeDiagnostics('file:///valid-story.tw', workspace);
    const errorDiags = computeDiagnostics('file:///errors.tw', workspace);

    // Valid story should have zero error-severity diagnostics
    const validErrors = validDiags.filter(d => d.severity === 'error');
    expect(validErrors).toHaveLength(0);

    // Error file should have at least one diagnostic
    expect(errorDiags.length).toBeGreaterThan(0);

    // Error file should have at least SP100 (undefined macro) and SP101 (unmatched container)
    const codes = new Set(errorDiags.map(d => d.code));
    expect(codes.has('SP100')).toBe(true);
    expect(codes.has('SP101')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 2. Cross-plugin: Completions suggest same macros diagnostics validates
  // -----------------------------------------------------------------------

  it('completions suggest the same macros that diagnostics validates against', () => {
    workspace = buildWorkspace({
      'valid-story.tw': validStory,
    });

    // Get all available macro completions (simulating cursor after `{` on a line)
    // Line 6 of valid-story.tw: "{set $health = 100}" → position after opening `{`
    const completions = getCompletions(
      'file:///valid-story.tw',
      { line: 6, character: 1 }, // after '{'
      '{',
      workspace,
    );

    // Extract macro names from completions
    const completionNames = new Set(completions.map(c => c.label));

    // "if" and "set" should be available as completions
    expect(completionNames.has('if')).toBe(true);
    expect(completionNames.has('set')).toBe(true);

    // Now verify that using these macros does NOT produce SP100 diagnostics
    const diags = computeDiagnostics('file:///valid-story.tw', workspace);
    const sp100 = diags.filter(d => d.code === 'SP100');

    // The valid file uses {set} and {if}, which are in completions,
    // so no SP100 should exist for them
    expect(sp100.some(d => d.message.includes('{set}'))).toBe(false);
    expect(sp100.some(d => d.message.includes('{if}'))).toBe(false);

    // Conversely, "unknownMacro" should NOT be in completions
    expect(completionNames.has('unknownMacro')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 3. Cross-plugin: Widgets in completions, diagnostics, and hover
  // -----------------------------------------------------------------------

  it('widgets appear in completions and are not flagged by diagnostics', () => {
    const storyWithWidget = `:: Start
{greeting "Alice"}
[[Next]]

:: Next
{counter 1 "score"}
`;
    workspace = buildWorkspace({
      'widgets.tw': widgetsFile,
      'story.tw': storyWithWidget,
    });

    // Widget "greeting" should appear in macro completions
    const completions = getCompletions(
      'file:///story.tw',
      { line: 1, character: 1 },
      '{',
      workspace,
    );
    const completionLabels = completions.map(c => c.label);
    expect(completionLabels).toContain('greeting');
    expect(completionLabels).toContain('counter');

    // Using the widget correctly should not produce SP100 (undefined macro)
    const diags = computeDiagnostics('file:///story.tw', workspace);
    const sp100 = diags.filter(d => d.code === 'SP100');
    expect(sp100.some(d => d.message.includes('greeting'))).toBe(false);
    expect(sp100.some(d => d.message.includes('counter'))).toBe(false);

    // Hover on the widget name should provide widget info
    const hover = getHoverInfo(
      'file:///story.tw',
      { line: 1, character: 2 }, // on "greeting"
      workspace,
    );
    expect(hover).not.toBeNull();
    expect(hover!.contents).toContain('greeting');
  });

  // -----------------------------------------------------------------------
  // 4. Cross-plugin: Rename updates all references found by references plugin
  // -----------------------------------------------------------------------

  it('renaming a passage updates all references found by references plugin', () => {
    const multiFile = `:: StoryVariables
$x = 1

:: Start
Welcome!
[[Kitchen]]
{goto "Kitchen"}

:: Kitchen
You see a table.
[[Start]]
`;
    workspace = buildWorkspace({
      'story.tw': multiFile,
    });

    // First, find all references to "Kitchen" via the references plugin
    // "Kitchen" passage header is at line 8, character 3
    const refs = findPassageReferences('Kitchen', workspace, true);

    // Should find the declaration (line 8) + at least the [[Kitchen]] link (line 5)
    // and the {goto "Kitchen"} reference (line 6)
    expect(refs.length).toBeGreaterThanOrEqual(2);

    // Now compute a rename of "Kitchen" to "DiningRoom"
    // Position the cursor on the "Kitchen" header (line 8, char 3)
    const renameEdits = computeRename(
      'file:///story.tw',
      { line: 8, character: 3 },
      'DiningRoom',
      workspace,
    );

    // Rename should produce edits
    expect(renameEdits.size).toBeGreaterThan(0);

    const edits = renameEdits.get('file:///story.tw') ?? [];

    // Every reference location should have a corresponding rename edit
    // (the rename plugin uses findPassageReferences internally)
    expect(edits.length).toBe(refs.length);

    // All rename edits should have the new name
    for (const edit of edits) {
      expect(edit.newText).toBe('DiningRoom');
    }
  });

  // -----------------------------------------------------------------------
  // 5. Cross-plugin: Definition and references are consistent
  // -----------------------------------------------------------------------

  it('definition points to the same passage that references includes as declaration', () => {
    const story = `:: Start
Go to [[Kitchen]]

:: Kitchen
The kitchen is warm.
`;
    workspace = buildWorkspace({
      'story.tw': story,
    });

    // Get definition from the [[Kitchen]] link on line 1
    // The link text "Kitchen" starts after "[[" (character 8)
    const def = getDefinition(
      'file:///story.tw',
      { line: 1, character: 10 }, // inside "Kitchen" in [[Kitchen]]
      workspace,
    );

    expect(def).not.toBeNull();

    // Get references for Kitchen including declaration
    const refs = findPassageReferences('Kitchen', workspace, true);

    // The definition target should match the declaration reference
    const declRef = refs.find(r =>
      r.range.start.line === def!.range.start.line &&
      r.uri === def!.uri,
    );
    expect(declRef).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // 6. Multi-file workspace: diagnostics account for cross-file passages
  // -----------------------------------------------------------------------

  it('diagnostics account for passages across multiple files', () => {
    const file1 = `:: Start
[[PageTwo]]
`;
    const file2 = `:: PageTwo
Content here.
`;

    workspace = buildWorkspace({
      'file1.tw': file1,
      'file2.tw': file2,
    });

    // file1 links to PageTwo which is in file2 — no broken link
    const diags = computeDiagnostics('file:///file1.tw', workspace);
    const sp300 = diags.filter(d => d.code === 'SP300');
    expect(sp300).toHaveLength(0);

    // Now test with a missing target
    const file3 = `:: Orphan
[[MissingPage]]
`;
    const workspace2 = buildWorkspace({
      'file1.tw': file1,
      'file2.tw': file2,
      'file3.tw': file3,
    });

    const diags3 = computeDiagnostics('file:///file3.tw', workspace2);
    const sp300b = diags3.filter(d => d.code === 'SP300');
    expect(sp300b.length).toBeGreaterThan(0);
    expect(sp300b[0].message).toContain('MissingPage');

    workspace2.dispose();
  });

  // -----------------------------------------------------------------------
  // 6b. SP110: cross-file passage parameter validation
  // -----------------------------------------------------------------------

  it('SP110: passage parameter resolves across files (issue #9)', () => {
    // Simulate a macro with a "passage" parameter type (e.g. {choice})
    const file1 = `:: arrival-docking [intro]
{goto "arrival-alma-flickers"}
`;
    const file2 = `:: arrival-alma-flickers [intro]
Content here.
`;

    workspace = buildWorkspace({
      'docking.tw': file1,
      'alma-flickers.tw': file2,
    });

    // Override goto's parameter to use "passage" type (simulates user-defined macro config)
    workspace.macros.addMacro({
      name: 'goto',
      parameters: ['passage'],
    });

    const diags = computeDiagnostics('file:///docking.tw', workspace);
    const sp110 = diags.filter(d => d.code === 'SP110');
    // Passage exists in another file — no SP110 expected
    expect(sp110).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 6c. Cross-file passages after document close (LSP flow)
  // -----------------------------------------------------------------------

  it('closing a document removes its passages (server re-reads from disk)', () => {
    const file1 = `:: Start
{goto "PageTwo"}
`;
    const file2 = `:: PageTwo
Content.
`;

    workspace = buildWorkspace({
      'file1.tw': file1,
      'file2.tw': file2,
    });

    workspace.macros.addMacro({
      name: 'goto',
      parameters: ['passage'],
    });

    // Initially correct — no SP110
    let diags = computeDiagnostics('file:///file1.tw', workspace);
    let sp110 = diags.filter(d => d.code === 'SP110');
    expect(sp110).toHaveLength(0);

    // At the WorkspaceModel level, close() removes passages (expected).
    // The server's onDidCloseTextDocument handler is responsible for
    // re-reading from disk to preserve workspace-scanned files.
    workspace.documents.close('file:///file2.tw');

    diags = computeDiagnostics('file:///file1.tw', workspace);
    sp110 = diags.filter(d => d.code === 'SP110');
    // After close, the document store no longer has file2, so SP110 fires.
    // In the real LSP server, onDidCloseTextDocument re-reads from disk.
    expect(sp110.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 6d. LSP flow: didOpen before workspace scan, then scan completes
  // -----------------------------------------------------------------------

  it('SP110: editor opens file before workspace scan, scan completes later', async () => {
    // Simulate LSP flow: workspace not yet initialized, editor opens a file
    workspace = new WorkspaceModel();
    workspace.macros.addMacro({
      name: 'goto',
      parameters: ['passage'],
    });

    const file1 = `:: Start
{goto "PageTwo"}
`;
    const file2 = `:: PageTwo
Content.
`;

    // Step 1: Editor opens file1 before scan (workspace not initialized)
    workspace.documents.open('file:///file1.tw', file1);

    // Diagnostics should be empty (initialized = false guard)
    let diags = computeDiagnostics('file:///file1.tw', workspace);
    expect(diags).toHaveLength(0);

    // Step 2: Workspace scan completes — initialize with all files
    const allFiles = new Map([
      ['file:///file1.tw', file1],
      ['file:///file2.tw', file2],
    ]);
    workspace.initialize(allFiles);

    // Step 3: After initialization, diagnostics should be correct
    diags = computeDiagnostics('file:///file1.tw', workspace);
    const sp110 = diags.filter(d => d.code === 'SP110');
    expect(sp110).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 6e. LSP flow: workspace scan finds no files (workspaceRoot undefined)
  // -----------------------------------------------------------------------

  it('SP110: empty workspace scan then didOpen produces false positive', () => {
    // Simulate: workspaceRoot is undefined → scan returns empty map
    workspace = new WorkspaceModel();
    workspace.macros.addMacro({
      name: 'goto',
      parameters: ['passage'],
    });

    const file1 = `:: Start
{goto "PageTwo"}
`;

    // Initialize with empty scan (simulates undefined workspaceRoot)
    workspace.initialize(new Map());

    // Editor opens file1 after initialization
    workspace.documents.open('file:///file1.tw', file1);

    // Now diagnostics run with only file1's passages
    const diags = computeDiagnostics('file:///file1.tw', workspace);
    const sp110 = diags.filter(d => d.code === 'SP110');
    // PageTwo doesn't exist → SP110 fires (this is correct behavior since no other files)
    expect(sp110.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 7. Variable completions are consistent with variable diagnostics
  // -----------------------------------------------------------------------

  it('variable completions suggest only declared variables; diagnostics flags undeclared ones', () => {
    workspace = buildWorkspace({
      'variables.tw': variablesFile,
    });

    // Get variable completions (cursor after '$' on a line with a variable)
    // Line 5: "{set $health = 50}" — position after '$'
    const completions = getCompletions(
      'file:///variables.tw',
      { line: 5, character: 6 }, // after '$'
      '$',
      workspace,
    );

    const completionLabels = completions.map(c => c.label);

    // $health and $name are declared in StoryVariables
    expect(completionLabels).toContain('$health');
    expect(completionLabels).toContain('$name');

    // Now check diagnostics: $unknown (line 6) should be flagged as SP200
    const diags = computeDiagnostics('file:///variables.tw', workspace);
    const sp200 = diags.filter(d => d.code === 'SP200');
    expect(sp200.some(d => d.message.includes('$unknown'))).toBe(true);

    // $health should NOT be flagged
    expect(sp200.some(d => d.message.includes('$health'))).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 8. Passage completions list all passages across workspace
  // -----------------------------------------------------------------------

  it('passage link completions include passages from all files', () => {
    const file1 = `:: Start
[[`;
    const file2 = `:: Kitchen
food here

:: Bedroom
sleep here
`;
    workspace = buildWorkspace({
      'file1.tw': file1,
      'file2.tw': file2,
    });

    // Get completions after "[["
    const completions = getCompletions(
      'file:///file1.tw',
      { line: 1, character: 2 },
      '[',
      workspace,
    );

    const labels = completions.map(c => c.label);
    expect(labels).toContain('Start');
    expect(labels).toContain('Kitchen');
    expect(labels).toContain('Bedroom');
  });

  // -----------------------------------------------------------------------
  // 9. PrepareRename works for passages, variables, and widgets
  // -----------------------------------------------------------------------

  it('prepareRename identifies renameable symbols across categories', () => {
    const story = `:: StoryVariables
$score = 0

:: Start
{set $score = 10}
[[Next]]

:: Next
Result: $score
`;
    workspace = buildWorkspace({
      'story.tw': story,
    });

    // Passage header "Start" is renameable (line 3, char 3)
    const passageRename = prepareRename(
      'file:///story.tw',
      { line: 3, character: 4 },
      workspace,
    );
    expect(passageRename).not.toBeNull();
    expect(passageRename!.placeholder).toBe('Start');

    // Variable "$score" is renameable (line 4, char 5)
    const varRename = prepareRename(
      'file:///story.tw',
      { line: 4, character: 6 },
      workspace,
    );
    expect(varRename).not.toBeNull();
    expect(varRename!.placeholder).toBe('score');
  });

  // -----------------------------------------------------------------------
  // 10. Document update triggers re-indexing
  // -----------------------------------------------------------------------

  it('updating a document re-indexes passages and affects diagnostics', () => {
    const original = `:: Start
[[Target]]

:: Target
Content.
`;
    workspace = buildWorkspace({
      'story.tw': original,
    });

    // Initially no broken link
    let diags = computeDiagnostics('file:///story.tw', workspace);
    let sp300 = diags.filter(d => d.code === 'SP300');
    expect(sp300).toHaveLength(0);

    // Now update document: remove the Target passage
    const updated = `:: Start
[[Target]]
`;
    workspace.documents.update('file:///story.tw', updated);

    // After update, Target is gone — broken link should appear
    diags = computeDiagnostics('file:///story.tw', workspace);
    sp300 = diags.filter(d => d.code === 'SP300');
    expect(sp300.length).toBeGreaterThan(0);
    expect(sp300[0].message).toContain('Target');
  });
});

// =========================================================================
// CLI end-to-end integration
// =========================================================================

describe('Integration: CLI end-to-end', () => {
  it('check command on error fixtures exits 1', async () => {
    const errorFile = join(fixturesDir, 'errors.tw');
    const { exitCode } = await captureStdout(() => runCheck([errorFile]));
    expect(exitCode).toBe(1);
  });

  it('check command on valid fixtures exits 0', async () => {
    const validFile = join(fixturesDir, 'valid-story.tw');
    const { exitCode } = await captureStdout(() => runCheck([validFile]));
    expect(exitCode).toBe(0);
  });

  it('check command on all fixtures combined includes diagnostics from error file', async () => {
    const allFixtures = join(fixturesDir, '*.tw');
    const { exitCode, output } = await captureStdout(() =>
      runCheck(['--format', 'json', allFixtures]),
    );
    // Should exit 1 because errors.tw has issues
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(output);
    expect(parsed.files.length).toBeGreaterThan(0);

    // At least one file should have diagnostics
    const withDiags = parsed.files.filter(
      (f: { diagnostics: unknown[] }) => f.diagnostics.length > 0,
    );
    expect(withDiags.length).toBeGreaterThan(0);
  });
});

// =========================================================================
// LSP protocol integration (spawned server over stdio)
// =========================================================================

interface PublishedDiagnostics {
  uri: string;
  diagnostics: LspDiagnostic[];
}

interface LspSession {
  conn: MessageConnection;
  publishes: PublishedDiagnostics[];
  /** Resolve with the first publish for `uri` (at or after index `from`) matching `predicate`. */
  waitForDiagnostics(
    uri: string,
    predicate: (diags: LspDiagnostic[]) => boolean,
    from?: number,
  ): Promise<LspDiagnostic[]>;
  /** Latest diagnostics published for `uri`, or undefined if none. */
  latest(uri: string): LspDiagnostic[] | undefined;
  close(): Promise<void>;
}

const repoRoot = join(import.meta.dirname, '..', '..');
let serverBundleDir: string | undefined;
let serverBundle: string;
const activeSessions: LspSession[] = [];
const tempDirs: string[] = [];

/**
 * Bundle the server so these tests do not depend on a prior `npm run build`.
 * The bundle lives under node_modules/.cache so runtime lookups of
 * @rohal12/spindle (builtin macro registry) still resolve.
 */
async function bundleServer(): Promise<void> {
  const cacheDir = join(repoRoot, 'node_modules', '.cache');
  mkdirSync(cacheDir, { recursive: true });
  serverBundleDir = mkdtempSync(join(cacheDir, 'spindle-lsp-test-'));
  serverBundle = join(serverBundleDir, 'bin.js');
  await build({
    entryPoints: [join(repoRoot, 'src', 'bin.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: serverBundle,
    external: ['prettier'],
    define: { SPINDLE_LSP_VERSION: JSON.stringify('test') },
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
    },
    logLevel: 'silent',
  });
}

function makeTempWorkspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-lsp-ws-'));
  tempDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function uriFor(dir: string, name: string): string {
  return pathToFileURL(join(dir, name)).toString();
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Spawn the server, run initialize/initialized, and return a session. */
async function startLsp(
  rootDir: string,
  initializationOptions: Record<string, unknown> = {},
): Promise<LspSession> {
  const proc = spawn(process.execPath, [serverBundle, '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stderr!.resume();
  const conn = createMessageConnection(
    new StreamMessageReader(proc.stdout!),
    new StreamMessageWriter(proc.stdin!),
  );

  const publishes: PublishedDiagnostics[] = [];
  const waiters: Array<() => void> = [];
  conn.onNotification('textDocument/publishDiagnostics', (params: PublishedDiagnostics) => {
    publishes.push(params);
    for (const w of waiters.slice()) w();
  });
  // Accept client/registerCapability and any other server-to-client request.
  conn.onRequest(() => null);
  conn.listen();

  await conn.sendRequest('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(rootDir).toString(),
    capabilities: {},
    initializationOptions,
  });
  await conn.sendNotification('initialized', {});

  const session: LspSession = {
    conn,
    publishes,
    latest(uri) {
      for (let i = publishes.length - 1; i >= 0; i--) {
        if (publishes[i].uri === uri) return publishes[i].diagnostics;
      }
      return undefined;
    },
    waitForDiagnostics(uri, predicate, from = 0) {
      return new Promise((resolve, reject) => {
        let index = from;
        const check = () => {
          for (; index < publishes.length; index++) {
            const p = publishes[index];
            if (p.uri === uri && predicate(p.diagnostics)) {
              cleanup();
              resolve(p.diagnostics);
              return;
            }
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(
            `Timed out waiting for diagnostics on ${uri}; latest codes: ` +
            JSON.stringify(session.latest(uri)?.map(d => d.code)),
          ));
        }, 4000);
        const cleanup = () => {
          clearTimeout(timer);
          const i = waiters.indexOf(check);
          if (i >= 0) waiters.splice(i, 1);
        };
        waiters.push(check);
        check();
      });
    },
    async close() {
      try {
        await conn.sendRequest('shutdown');
        await conn.sendNotification('exit');
      } catch {
        // Server may already be gone
      }
      conn.dispose();
      proc.kill();
    },
  };
  activeSessions.push(session);
  return session;
}

const codesOf = (diags: LspDiagnostic[]) => diags.map(d => String(d.code));
const hasCode = (code: string) => (diags: LspDiagnostic[]) => codesOf(diags).includes(code);
const lacksCode = (code: string) => (diags: LspDiagnostic[]) => !codesOf(diags).includes(code);

async function documentSymbolNames(session: LspSession, uri: string): Promise<string[]> {
  const symbols = await session.conn.sendRequest('textDocument/documentSymbol', {
    textDocument: { uri },
  }) as Array<{ name: string }>;
  return symbols.map(s => s.name);
}

function didOpen(session: LspSession, uri: string, text: string): Promise<void> {
  return session.conn.sendNotification('textDocument/didOpen', {
    textDocument: { uri, languageId: 'twee', version: 1, text },
  });
}

function didChangeFull(session: LspSession, uri: string, version: number, text: string): Promise<void> {
  return session.conn.sendNotification('textDocument/didChange', {
    textDocument: { uri, version },
    contentChanges: [{ text }],
  });
}

function didClose(session: LspSession, uri: string): Promise<void> {
  return session.conn.sendNotification('textDocument/didClose', {
    textDocument: { uri },
  });
}

/** FileChangeType: 1 = Created, 2 = Changed, 3 = Deleted. */
function watchedFileChanged(session: LspSession, uri: string, type: 1 | 2 | 3): Promise<void> {
  return session.conn.sendNotification('workspace/didChangeWatchedFiles', {
    changes: [{ uri, type }],
  });
}

describe('Integration: LSP server over stdio', () => {
  beforeAll(async () => {
    await bundleServer();
  });

  afterEach(async () => {
    while (activeSessions.length > 0) {
      await activeSessions.pop()!.close();
    }
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    if (serverBundleDir) rmSync(serverBundleDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // #14: unsaved editor buffers stay authoritative
  // -----------------------------------------------------------------------

  it('keeps an unsaved buffer opened before the initial scan finishes (#14)', async () => {
    const dir = makeTempWorkspace({ 'story.twee': ':: Disk\nOn disk.\n' });
    const uri = uriFor(dir, 'story.twee');
    const session = await startLsp(dir);

    await didOpen(session, uri, ':: Unsaved\nIn the editor.\n');
    // Wait for the initial scan to finish (modelReady publishes the URI)
    await session.waitForDiagnostics(uri, () => true, 0);
    await sleep(400);

    expect(await documentSymbolNames(session, uri)).toEqual(['Unsaved']);
  });

  it('ignores watched-file changes and deletions for open documents until didClose (#14)', async () => {
    const dir = makeTempWorkspace({
      'story.twee': ':: Disk\nOn disk.\n',
      'other.twee': ':: Other\n[[Disk]]\n',
    });
    const uri = uriFor(dir, 'story.twee');
    const session = await startLsp(dir);
    await session.waitForDiagnostics(uri, () => true);

    await didOpen(session, uri, ':: Disk\nOn disk.\n');
    await didChangeFull(session, uri, 2, ':: Edited\nUnsaved edit.\n');

    // External change to the file on disk while it has unsaved edits
    writeFileSync(join(dir, 'story.twee'), ':: DiskChanged\nChanged on disk.\n');
    await watchedFileChanged(session, uri, 2);
    expect(await documentSymbolNames(session, uri)).toEqual(['Edited']);

    // External deletion while the editor still holds the buffer
    unlinkSync(join(dir, 'story.twee'));
    await watchedFileChanged(session, uri, 3);
    expect(await documentSymbolNames(session, uri)).toEqual(['Edited']);
  });

  it('keeps passages of an on-disk file after its editor tab closes (#9)', async () => {
    const dir = makeTempWorkspace({
      'start.twee': ':: Start\n[[Target]]\n',
      'target.twee': ':: Target\nArrived.\n',
    });
    const startUri = uriFor(dir, 'start.twee');
    const targetUri = uriFor(dir, 'target.twee');
    const session = await startLsp(dir);
    await session.waitForDiagnostics(startUri, lacksCode('SP300'));

    await didOpen(session, targetUri, ':: Target\nArrived.\n');
    await didClose(session, targetUri);
    const mark = session.publishes.length;
    await sleep(400);

    expect(await documentSymbolNames(session, targetUri)).toEqual(['Target']);
    const startDiags = session.publishes.slice(mark).filter(p => p.uri === startUri);
    for (const p of startDiags) {
      expect(codesOf(p.diagnostics)).not.toContain('SP300');
    }
  });

  // -----------------------------------------------------------------------
  // #30: per-code diagnostic disable settings
  // -----------------------------------------------------------------------

  it('honors diagnostics: {SP100: false} from initializationOptions (#30)', async () => {
    const story = ':: Start\n{newmacro}\n[[Missing]]\n';
    const dir = makeTempWorkspace({ 'story.twee': story });
    const uri = uriFor(dir, 'story.twee');
    const session = await startLsp(dir, { diagnostics: { SP100: false } });

    // modelReady path: other codes stay enabled, SP100 is filtered
    const ready = await session.waitForDiagnostics(uri, hasCode('SP300'));
    expect(codesOf(ready)).not.toContain('SP100');

    // Immediate (documentChanged) path
    const mark = session.publishes.length;
    await didOpen(session, uri, story);
    await didChangeFull(session, uri, 2, story + '{othermacro}\n');
    await sleep(400);
    const later = session.publishes.slice(mark).filter(p => p.uri === uri);
    expect(later.length).toBeGreaterThan(0);
    for (const p of later) {
      expect(codesOf(p.diagnostics)).toContain('SP300');
      expect(codesOf(p.diagnostics)).not.toContain('SP100');
    }
  });

  // -----------------------------------------------------------------------
  // #31: clear diagnostics when a document leaves the store
  // -----------------------------------------------------------------------

  it('clears diagnostics when a closed untitled document leaves the store (#31)', async () => {
    const dir = makeTempWorkspace({ 'story.twee': ':: Start\nHello.\n' });
    const session = await startLsp(dir);
    await session.waitForDiagnostics(uriFor(dir, 'story.twee'), () => true);

    const uri = 'untitled:Untitled-1';
    await didOpen(session, uri, ':: Scratch\n{newmacro}\n');
    const mark = session.publishes.length;
    await session.waitForDiagnostics(uri, hasCode('SP100'));

    await didClose(session, uri);
    await session.waitForDiagnostics(uri, diags => diags.length === 0, mark);
    await sleep(400);
    expect(session.latest(uri)).toEqual([]);
  });

  it('clears diagnostics for a file deleted on disk (#31)', async () => {
    const dir = makeTempWorkspace({
      'start.twee': ':: Start\nHello.\n',
      'broken.twee': ':: Broken\n{newmacro}\n',
    });
    const uri = uriFor(dir, 'broken.twee');
    const session = await startLsp(dir);
    await session.waitForDiagnostics(uri, hasCode('SP100'));

    const mark = session.publishes.length;
    unlinkSync(join(dir, 'broken.twee'));
    await watchedFileChanged(session, uri, 3);
    await session.waitForDiagnostics(uri, diags => diags.length === 0, mark);
    await sleep(400);
    expect(session.latest(uri)).toEqual([]);
  });

  it('clears diagnostics when an open file deleted on disk is closed (#14, #31)', async () => {
    const dir = makeTempWorkspace({ 'story.twee': ':: Start\n{newmacro}\n' });
    const uri = uriFor(dir, 'story.twee');
    const session = await startLsp(dir);
    await session.waitForDiagnostics(uri, hasCode('SP100'));

    await didOpen(session, uri, ':: Start\n{newmacro}\n');
    unlinkSync(join(dir, 'story.twee'));
    await watchedFileChanged(session, uri, 3);
    // Still open in the editor: diagnostics remain
    expect(await documentSymbolNames(session, uri)).toEqual(['Start']);

    const mark = session.publishes.length;
    await didClose(session, uri);
    await session.waitForDiagnostics(uri, diags => diags.length === 0, mark);
    expect(await documentSymbolNames(session, uri)).toEqual([]);
  });

  it('keeps diagnostics for an on-disk document that merely closes in the editor (#31)', async () => {
    const story = ':: Start\n{newmacro}\n';
    const dir = makeTempWorkspace({ 'story.twee': story });
    const uri = uriFor(dir, 'story.twee');
    const session = await startLsp(dir);
    await session.waitForDiagnostics(uri, hasCode('SP100'));

    await didOpen(session, uri, story);
    await didClose(session, uri);
    await sleep(400);
    expect(codesOf(session.latest(uri)!)).toContain('SP100');
  });

  // -----------------------------------------------------------------------
  // #29: reload macro configuration on watched config-file changes
  // -----------------------------------------------------------------------

  it('reloads macros when spindle.config.json is created, changed, and deleted (#29)', async () => {
    const story = ':: Start\n{newmacro}\n';
    const dir = makeTempWorkspace({ 'story.twee': story });
    const uri = uriFor(dir, 'story.twee');
    const configPath = join(dir, 'spindle.config.json');
    const configUri = uriFor(dir, 'spindle.config.json');
    const withMacro = JSON.stringify({ macros: { newmacro: { parameters: [] } } });
    const session = await startLsp(dir);

    await didOpen(session, uri, story);
    await session.waitForDiagnostics(uri, hasCode('SP100'));

    // Created
    let mark = session.publishes.length;
    writeFileSync(configPath, withMacro);
    await watchedFileChanged(session, configUri, 1);
    await session.waitForDiagnostics(uri, lacksCode('SP100'), mark);

    // Changed: macro removed from config
    mark = session.publishes.length;
    writeFileSync(configPath, JSON.stringify({ macros: {} }));
    await watchedFileChanged(session, configUri, 2);
    await session.waitForDiagnostics(uri, hasCode('SP100'), mark);

    // Changed: macro added back
    mark = session.publishes.length;
    writeFileSync(configPath, withMacro);
    await watchedFileChanged(session, configUri, 2);
    await session.waitForDiagnostics(uri, lacksCode('SP100'), mark);

    // Deleted
    mark = session.publishes.length;
    unlinkSync(configPath);
    await watchedFileChanged(session, configUri, 3);
    await session.waitForDiagnostics(uri, hasCode('SP100'), mark);

    // The config file must never be treated as a story document
    expect(session.publishes.some(p => p.uri === configUri)).toBe(false);
    expect(await documentSymbolNames(session, configUri)).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // #47: discover JS/TS custom macros during the initial workspace scan
  // -----------------------------------------------------------------------

  it('discovers custom macros from existing JS/TS files during the initial scan (#47)', async () => {
    const dir = makeTempWorkspace({
      'macros.js': 'Story.defineMacro({ name: "hello", render() { return null; } });\n',
      'story.tw': ':: Start\n{hello}\n{greet}\n{vendored}\n{bundled}\n[[Missing]]\n',
    });
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(
      join(dir, 'scripts', 'greet.ts'),
      'Story.defineMacro({ name: "greet", render(): null { return null; } });\n',
    );
    // Dependency and build-output directories are not macro sources
    mkdirSync(join(dir, 'node_modules', 'some-lib'), { recursive: true });
    writeFileSync(
      join(dir, 'node_modules', 'some-lib', 'index.js'),
      'Story.defineMacro({ name: "vendored", render() { return null; } });\n',
    );
    mkdirSync(join(dir, 'dist'));
    writeFileSync(
      join(dir, 'dist', 'app.bundle.js'),
      'Story.defineMacro({ name: "bundled", render() { return null; } });\n',
    );
    const uri = uriFor(dir, 'story.tw');
    const session = await startLsp(dir);
    await didOpen(session, uri, readFileSync(join(dir, 'story.tw'), 'utf-8'));

    // SP300 (broken link) is only reported once the initial scan has
    // completed, so this publish reflects the scanned workspace.
    const diags = await session.waitForDiagnostics(uri, hasCode('SP300'));
    const sp100 = diags.filter(d => d.code === 'SP100').map(d => d.message);
    expect(sp100).toEqual([
      'Unrecognized macro: {vendored}',
      'Unrecognized macro: {bundled}',
    ]);

    // Watcher events for excluded files don't add them either
    await watchedFileChanged(session, uriFor(dir, 'node_modules/some-lib/index.js'), 2);
    await watchedFileChanged(session, uriFor(dir, 'dist/app.bundle.js'), 2);
    const mark = session.publishes.length;
    await didChangeFull(session, uri, 2, ':: Start\n{vendored}\n{bundled}\n[[Missing]]\n');
    const after = await session.waitForDiagnostics(uri, hasCode('SP300'), mark);
    expect(after.filter(d => d.code === 'SP100').map(d => d.message)).toEqual([
      'Unrecognized macro: {vendored}',
      'Unrecognized macro: {bundled}',
    ]);
  });

  it('skips JS/TS in dot-folders both in the initial scan and on watcher events (#47)', async () => {
    const dir = makeTempWorkspace({
      'macros.js': 'Story.defineMacro({ name: "hello", render() { return null; } });\n',
      'story.tw': ':: Start\n{hello}\n{storybook}\n{cfg}\n[[Missing]]\n',
    });
    mkdirSync(join(dir, '.storybook'));
    writeFileSync(
      join(dir, '.storybook', 'preview.js'),
      'Story.defineMacro({ name: "storybook", render() { return null; } });\n',
    );
    mkdirSync(join(dir, '.config'));
    writeFileSync(
      join(dir, '.config', 'macros.ts'),
      'Story.defineMacro({ name: "cfg", render(): null { return null; } });\n',
    );
    const uri = uriFor(dir, 'story.tw');
    const session = await startLsp(dir);
    await didOpen(session, uri, readFileSync(join(dir, 'story.tw'), 'utf-8'));

    const expected = ['Unrecognized macro: {storybook}', 'Unrecognized macro: {cfg}'];
    const diags = await session.waitForDiagnostics(uri, hasCode('SP300'));
    expect(diags.filter(d => d.code === 'SP100').map(d => d.message)).toEqual(expected);

    // Watcher events for them must agree with the initial scan
    await watchedFileChanged(session, uriFor(dir, '.storybook/preview.js'), 2);
    await watchedFileChanged(session, uriFor(dir, '.config/macros.ts'), 2);
    const mark = session.publishes.length;
    await didChangeFull(session, uri, 2, ':: Start\n{hello}\n{storybook}\n{cfg}\n[[Missing]]\n\n');
    const after = await session.waitForDiagnostics(uri, hasCode('SP300'), mark);
    expect(after.filter(d => d.code === 'SP100').map(d => d.message)).toEqual(expected);
  });

  // -----------------------------------------------------------------------
  // #60: format requests indent block widget bodies like other containers
  // -----------------------------------------------------------------------

  it('indents block widget bodies in formatting and range formatting requests (#60)', async () => {
    const story = ':: Widgets [widget]\n{widget "box"}\n{@children}\n{/widget}\n'
      + '{widget "greet"}\nHi\n{/widget}\n\n'
      + ':: Start\n{box}\nHello\n{/box}\n{greet}\nAfter\n{if true}\nYes\n{/if}\n';
    const dir = makeTempWorkspace({ 'story.twee': story });
    const uri = uriFor(dir, 'story.twee');
    const session = await startLsp(dir);
    await didOpen(session, uri, story);
    await session.waitForDiagnostics(uri, () => true);

    // {box} renders {@children}, so it is a container; {greet} is inline.
    const expected = ':: Widgets [widget]\n{widget "box"}\n  {@children}\n{/widget}\n'
      + '{widget "greet"}\n  Hi\n{/widget}\n\n'
      + ':: Start\n{box}\n  Hello\n{/box}\n{greet}\nAfter\n{if true}\n  Yes\n{/if}\n';
    const options = { tabSize: 2, insertSpaces: true };

    const edits = await session.conn.sendRequest('textDocument/formatting', {
      textDocument: { uri },
      options,
    }) as Array<{ newText: string }>;
    expect(edits).toHaveLength(1);
    expect(edits[0].newText).toBe(expected);

    const rangeEdits = await session.conn.sendRequest('textDocument/rangeFormatting', {
      textDocument: { uri },
      range: { start: { line: 8, character: 0 }, end: { line: 11, character: 0 } },
      options,
    }) as Array<{ newText: string }>;
    expect(rangeEdits).toHaveLength(1);
    expect(rangeEdits[0].newText).toBe(expected);
  });

  it('reloads macros from a legacy t3lt.twee-config.yaml change (#29)', async () => {
    const story = ':: Start\n{legacymacro}\n';
    const dir = makeTempWorkspace({
      'story.twee': story,
      't3lt.twee-config.yaml': 'spindle-0:\n  macros: {}\n',
    });
    const uri = uriFor(dir, 'story.twee');
    const configUri = uriFor(dir, 't3lt.twee-config.yaml');
    const session = await startLsp(dir);
    await session.waitForDiagnostics(uri, hasCode('SP100'));

    const mark = session.publishes.length;
    writeFileSync(
      join(dir, 't3lt.twee-config.yaml'),
      'spindle-0:\n  macros:\n    legacymacro:\n      parameters: []\n',
    );
    await watchedFileChanged(session, configUri, 2);
    await session.waitForDiagnostics(uri, lacksCode('SP100'), mark);
    expect(session.publishes.some(p => p.uri === configUri)).toBe(false);
  });
});
