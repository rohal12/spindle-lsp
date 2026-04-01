import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
