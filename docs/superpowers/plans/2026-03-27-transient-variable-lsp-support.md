# Transient Variable LSP Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full `%` transient variable sigil support to spindle-lsp with parity to `$` story variables.

**Architecture:** Add `%` to every regex, type union, and branch that currently handles `$`/`_`/`@`. Parse `StoryTransients` passage for declarations. Add diagnostics, completions, hover, semantic tokens, references, rename, inlay hints, and code actions for `%` variables.

**Tech Stack:** TypeScript, vscode-languageserver, Vitest

---

### Task 1: Types + Parsing Layer — `%` Sigil Recognition

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/parsing/argument-lexer.ts`
- Modify: `src/core/parsing/macro-parser.ts`
- Modify: `src/core/diagnostic-codes.ts`

- [ ] **Step 1: Add `%` to DeclaredVariable sigil union**

In `src/core/types.ts`, line 61:

```typescript
  sigil: '$' | '_' | '@' | '%';
```

- [ ] **Step 2: Add `%` to argument lexer**

In `src/core/parsing/argument-lexer.ts`:

Line 35 — update `Arg.sigil` type:
```typescript
  sigil?: '$' | '_' | '@' | '%';
```

Line 73 — update `varTestRegexp` to include `%`:
```typescript
const varTestRegexp = /^[$_@%][$A-Za-z_a-z][$0-9A-Z_.a-z]*/;
```

Line 100 — update type assertion:
```typescript
        const sigil = text[0] as '$' | '_' | '@' | '%';
```

- [ ] **Step 3: Add `%` to macro parser interpolation regex**

In `src/core/parsing/macro-parser.ts`, line 7:

```typescript
const variableInterpolationRegex = /(?<!\\)\{([$_@%][A-Za-z_$][\w$.]*)\}/g;
```

- [ ] **Step 4: Add transient diagnostic codes**

In `src/core/diagnostic-codes.ts`, add after line 15:

```typescript
  UndeclaredTransient: 'SP203',
```

Add to `severityMap` after line 41:
```typescript
  SP203: 'warning',
```

- [ ] **Step 5: Run type check and tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/parsing/argument-lexer.ts src/core/parsing/macro-parser.ts src/core/diagnostic-codes.ts
git commit -m "feat: add % transient sigil to types, lexer, and parser"
```

---

### Task 2: Variable Tracker — StoryTransients Parsing

**Files:**
- Modify: `src/core/workspace/variable-tracker.ts`
- Modify: `src/core/workspace/passage-index.ts`
- Modify: `src/core/workspace/workspace-model.ts`

- [ ] **Step 1: Add `StoryTransients` to passage index**

In `src/core/workspace/passage-index.ts`, after `getStoryVariables()` (line 104-106), add:

```typescript
  /** Get the StoryTransients passage, if any. */
  getStoryTransients(): Passage | undefined {
    return this.getPassage('StoryTransients');
  }
```

- [ ] **Step 2: Add transient variable tracking to VariableTracker**

In `src/core/workspace/variable-tracker.ts`:

Add a new regex at line 5 (after `varRefRegex`):
```typescript
/** Regex to match %transient references including dot notation. */
const transientRefRegex = /(?<!\w)%([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
```

Add `StoryTransients` to `EXCLUDED_PASSAGES` (line 8-10):
```typescript
const EXCLUDED_PASSAGES = new Set([
  'StoryVariables', 'StoryTransients', 'StoryInit', 'StoryData', 'StoryScript', 'StoryInterface',
]);
```

Add new state fields to the `VariableTracker` class (after line 34):
```typescript
  private declaredTransient = new Map<string, DeclaredVariable>();
  private _hasStoryTransients = false;
  private transientUsagesByUri = new Map<string, VariableUsage[]>();
```

Add `parseStoryTransients` method (after `parseStoryVariables`, ~line 74):
```typescript
  /**
   * Parse the StoryTransients passage content for transient declarations.
   * Each line like `%name = value` becomes a declaration.
   */
  parseStoryTransients(content: string): void {
    this.declaredTransient.clear();
    this._hasStoryTransients = true;

    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('<!--')) continue;

      const match = /^%([A-Za-z_$][\w$]*)\s*=\s*(.*)$/.exec(trimmed);
      if (!match) continue;

      const name = match[1];
      const expr = match[2].trim();
      const decl: DeclaredVariable = { name, sigil: '%' };

      if (expr.startsWith('{')) {
        const fieldRegex = /(\w+)\s*:/g;
        let fieldMatch;
        const fields: string[] = [];
        while ((fieldMatch = fieldRegex.exec(expr)) !== null) {
          fields.push(fieldMatch[1]);
        }
        if (fields.length > 0) {
          decl.fields = fields;
        }
      }

      this.declaredTransient.set(name, decl);
    }
  }
```

Add `%` scanning to `scanDocument` method. After the existing `$` reference scanning loop (~line 144), add:

```typescript
      // Find transient variable references
      const transRe = new RegExp(transientRefRegex.source, 'g');
      let transMatch;
      while ((transMatch = transRe.exec(cleaned)) !== null) {
        const fullName = transMatch[1];
        const baseName = fullName.split('.')[0];
        const charOffset = transMatch.index;

        let localLine = 0;
        for (let i = 0; i < lineOffsets.length; i++) {
          if (lineOffsets[i] > charOffset) break;
          localLine = i;
        }
        const character = charOffset - lineOffsets[localLine];
        const absoluteLine = contentStartLine + localLine;

        const range: Range = {
          start: { line: absoluteLine, character },
          end: { line: absoluteLine, character: character + transMatch[0].length },
        };

        transientUsages.push({ uri, baseName, fullName, range });
      }
```

Store transient usages separately. At the start of `scanDocument`, add:
```typescript
    this.transientUsagesByUri.delete(uri);
```
And at the end, alongside the existing `usagesByUri.set`:
```typescript
    if (transientUsages.length > 0) {
      this.transientUsagesByUri.set(uri, transientUsages);
    }
```

Initialize `transientUsages` at the start of the scanning loop:
```typescript
    const transientUsages: VariableUsage[] = [];
```

Add accessor methods:

```typescript
  /** Get all declared transient variables. */
  getDeclaredTransient(): Map<string, DeclaredVariable> {
    return this.declaredTransient;
  }

  /** Get all usages of a transient variable by base name. */
  getTransientUsages(name: string): Array<{ uri: string; range: Range }> {
    const results: Array<{ uri: string; range: Range }> = [];
    for (const usages of this.transientUsagesByUri.values()) {
      for (const u of usages) {
        if (u.baseName === name) {
          results.push({ uri: u.uri, range: u.range });
        }
      }
    }
    return results;
  }

  /** Get undeclared transient variable usages in a specific document. */
  getUndeclaredTransient(uri: string): Array<{ name: string; range: Range }> {
    const usages = this.transientUsagesByUri.get(uri);
    if (!usages) return [];

    const results: Array<{ name: string; range: Range }> = [];
    const seen = new Set<string>();

    for (const u of usages) {
      if (!this.declaredTransient.has(u.baseName) && !seen.has(u.baseName)) {
        seen.add(u.baseName);
        results.push({ name: u.baseName, range: u.range });
      }
    }
    return results;
  }

  /** Whether a StoryTransients passage has been parsed. */
  hasStoryTransients(): boolean {
    return this._hasStoryTransients;
  }
```

- [ ] **Step 3: Wire StoryTransients into workspace cascade**

In `src/core/workspace/workspace-model.ts`, in the `cascade()` method (after the StoryVariables block ending at line 162), add:

```typescript
    // Rescan StoryTransients
    const storyTransients = this.passages.getStoryTransients();
    if (storyTransients) {
      const text = this.documents.getText(storyTransients.uri);
      if (text) {
        const lines = text.split('\n');
        const contentStart = storyTransients.headerEnd.end.line + 1;
        let contentEnd = lines.length;
        for (let i = contentStart; i < lines.length; i++) {
          if (/^::\s+/.test(lines[i])) {
            contentEnd = i;
            break;
          }
        }
        const content = lines.slice(contentStart, contentEnd).join('\n');
        this.variables.parseStoryTransients(content);
      }
    }
```

- [ ] **Step 4: Run type check and tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/workspace/variable-tracker.ts src/core/workspace/passage-index.ts src/core/workspace/workspace-model.ts
git commit -m "feat: add StoryTransients passage parsing and transient tracking"
```

---

### Task 3: Completions — `%` Trigger and Suggestions

**Files:**
- Modify: `src/plugins/completions.ts`
- Test: `test/unit/completions.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/unit/completions.test.ts`:

```typescript
  it('returns transient variable completions after %', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryTransients\n%npcList = []\n%agents = {}\n\n:: Start\n{set %',
    });
    const items = getCompletions('file:///test.tw', { line: 5, character: 6 }, '%', ws);
    const labels = items.map(i => i.label);
    expect(labels).toContain('%npcList');
    expect(labels).toContain('%agents');
    expect(items.every(i => i.kind === 6)).toBe(true);
  });

  it('returns dot-path completions for %var.', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: StoryTransients\n%player = { health: 100, name: "Hero" }\n\n:: Start\n{%player.',
    });
    const items = getCompletions('file:///test.tw', { line: 4, character: 9 }, '.', ws);
    const labels = items.map(i => i.label);
    expect(labels).toContain('health');
    expect(labels).toContain('name');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/completions.test.ts`
Expected: FAIL

- [ ] **Step 3: Add `%` completion support**

In `src/plugins/completions.ts`:

Add `%` to trigger characters (line 238):
```typescript
      triggerCharacters: ['{', '$', '_', '@', '%', '[', '.'],
```

Add `%var.` dot-path context before the `$var.` check (after line 41):
```typescript
  // --- Context: dot-path field `%var.` ---
  const transientDotPathMatch = /%([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)?$/.exec(lineText);
  if (transientDotPathMatch) {
    return getTransientDotPathCompletions(transientDotPathMatch[1], workspace);
  }
```

Add `%` context check after the `@` check (after line 60):
```typescript
  // --- Context: transient variable `%` ---
  if (/%[A-Za-z_$]?[\w$]*$/.test(lineText) && !/%[A-Za-z_$][\w$]*\./.test(lineText)) {
    return getTransientVariableCompletions(workspace);
  }
```

Add the two helper functions (after `getDotPathCompletions`):

```typescript
function getTransientVariableCompletions(workspace: WorkspaceModel): CompletionItem[] {
  const declared = workspace.variables.getDeclaredTransient();
  if (declared.size === 0) return [];

  const items: CompletionItem[] = [];
  for (const [name, decl] of declared) {
    items.push({
      label: `%${name}`,
      kind: 6, // CompletionItemKind.Variable
      detail: 'transient variable',
      insertText: name,
      documentation: decl.fields && decl.fields.length > 0
        ? `Fields: ${decl.fields.join(', ')}`
        : undefined,
    });
  }
  return items;
}

function getTransientDotPathCompletions(varName: string, workspace: WorkspaceModel): CompletionItem[] {
  const declared = workspace.variables.getDeclaredTransient();
  const decl = declared.get(varName);
  if (!decl || !decl.fields || decl.fields.length === 0) return [];

  return decl.fields.map(field => ({
    label: field,
    kind: 5, // CompletionItemKind.Field
    detail: `field of %${varName}`,
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/completions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/completions.ts test/unit/completions.test.ts
git commit -m "feat: add % transient variable completions"
```

---

### Task 4: Hover — Transient Variable Info

**Files:**
- Modify: `src/plugins/hover.ts`

- [ ] **Step 1: Add `%` hover block**

In `src/plugins/hover.ts`, in `getVariableHover()`, after the `@` local variable block (after line 166), add:

```typescript
  // Transient variables: %name
  {
    const re = /(?<!\w)%([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        const baseName = match[1].split('.')[0];
        const decl = workspace.variables.getDeclaredTransient().get(baseName);
        const typeInfo = decl?.fields && decl.fields.length > 0
          ? `\n\nFields: ${decl.fields.map(f => `\`${f}\``).join(', ')}`
          : '';
        return {
          contents: `**Transient variable** \`%${match[1]}\`${typeInfo}`,
          range: {
            start: { line: position.line, character: start },
            end: { line: position.line, character: end },
          },
        };
      }
    }
  }
```

- [ ] **Step 2: Run type check and tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/plugins/hover.ts
git commit -m "feat: add % transient variable hover info"
```

---

### Task 5: Semantic Tokens — `%` Highlighting

**Files:**
- Modify: `src/plugins/semantic-tokens.ts`

- [ ] **Step 1: Add `%` semantic token regex and emission**

In `src/plugins/semantic-tokens.ts`, after `localVarRegex` (line 133), add:

```typescript
  const transientVarRegex = /(?<!\w)%([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
```

After the local vars block (after line 175), add:

```typescript
    // Transient vars (%var)
    transientVarRegex.lastIndex = 0;
    while ((m = transientVarRegex.exec(line)) !== null) {
      tokens.push({
        line: lineIndex,
        startChar: m.index,
        length: m[0].length,
        tokenType: encodeType('variable'),
        tokenModifiers: encodeModifiers(['defaultLibrary']),
      });
    }
```

- [ ] **Step 2: Run type check and tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/plugins/semantic-tokens.ts
git commit -m "feat: add % transient variable semantic tokens"
```

---

### Task 6: Diagnostics — Undeclared Transient Warnings

**Files:**
- Modify: `src/plugins/diagnostics.ts`

- [ ] **Step 1: Add transient variable validation**

In `src/plugins/diagnostics.ts`, in `validateVariables()`, after the SP200 block (after line 374), add:

```typescript
  // SP203: undeclared transient variable
  if (workspace.variables.hasStoryTransients()) {
    const undeclaredTransient = workspace.variables.getUndeclaredTransient(uri);
    for (const u of undeclaredTransient) {
      diagnostics.push(makeDiag(
        u.range,
        DiagnosticCode.UndeclaredTransient,
        `Transient variable '%${u.name}' is not declared in StoryTransients`,
      ));
    }
  }
```

- [ ] **Step 2: Run type check and tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/plugins/diagnostics.ts
git commit -m "feat: add undeclared transient variable diagnostics (SP203)"
```

---

### Task 7: References + Rename — `%` Variable Support

**Files:**
- Modify: `src/plugins/references.ts`
- Modify: `src/plugins/rename.ts`

- [ ] **Step 1: Add `%` to references**

In `src/plugins/references.ts`, after the `$variable` block (after line 63), add:

```typescript
  // --- %transient ---
  {
    const transRegex = /(?<!\w)%([A-Za-z_$][\w$]*)/g;
    let match: RegExpExecArray | null;
    while ((match = transRegex.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        const varName = match[1];
        return findTransientReferences(varName, workspace, includeDeclaration);
      }
    }
  }
```

Add the `findTransientReferences` function (after `findVariableReferences`):

```typescript
function findTransientReferences(
  varName: string,
  workspace: WorkspaceModel,
  includeDeclaration: boolean,
): Array<{ uri: string; range: Range }> {
  const results: Array<{ uri: string; range: Range }> = [];

  if (includeDeclaration) {
    const decl = workspace.variables.getDeclaredTransient().get(varName);
    if (decl?.declarationUri && decl.declarationRange) {
      results.push({ uri: decl.declarationUri, range: decl.declarationRange });
    }
  }

  results.push(...workspace.variables.getTransientUsages(varName));
  return results;
}
```

- [ ] **Step 2: Add `%` to rename**

In `src/plugins/rename.ts`, in `resolveSymbol()`, after the `$variable` block (after line 174), add:

```typescript
  // --- %transient ---
  {
    const transRegex = /(?<!\w)%([A-Za-z_$][\w$]*)/g;
    let match: RegExpExecArray | null;
    while ((match = transRegex.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        return {
          kind: 'variable',
          name: match[1],
          range: {
            start: { line: position.line, character: start },
            end: { line: position.line, character: end },
          },
        };
      }
    }
  }
```

In `computeEdits()`, update the `'variable'` case to also handle transient references. After line 72 (`const refs = findVariableReferences(...)`), check the sigil:

The rename `computeEdits` function needs to route `%` variables to `findTransientReferences`. Update the variable case:

```typescript
    case 'variable': {
      const bareName = newName.startsWith('$') ? newName.slice(1) :
                       newName.startsWith('%') ? newName.slice(1) : newName;
      // Determine if this is a transient variable
      const isTransient = workspace.variables.getDeclaredTransient().has(symbol.name);
      const refs = isTransient
        ? findTransientReferences(symbol.name, workspace, true)
        : findVariableReferences(symbol.name, workspace, true);
      for (const ref of refs) {
        addEdit(ref.uri, ref.range, bareName);
      }
      break;
    }
```

Import `findTransientReferences` from references.ts (export it) or duplicate the logic inline.

- [ ] **Step 3: Run type check and tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/plugins/references.ts src/plugins/rename.ts
git commit -m "feat: add % transient variable references and rename"
```

---

### Task 8: Inlay Hints + Code Actions

**Files:**
- Modify: `src/plugins/inlay-hints.ts`
- Modify: `src/plugins/code-actions.ts`

- [ ] **Step 1: Add `%` inlay hints in StoryTransients**

In `src/plugins/inlay-hints.ts`, in the function that generates variable type hints, after the StoryVariables block, add a parallel block for StoryTransients. Find where `storyVarsPassage` is used and add:

```typescript
  // StoryTransients type hints
  const storyTransientsPassage = workspace.passages.getStoryTransients();
  if (storyTransientsPassage && storyTransientsPassage.uri === uri) {
    const transLines = text.split('\n');
    const transStartLine = Math.max(range.start.line, 0);
    const transEndLine = Math.min(range.end.line, transLines.length - 1);

    for (let lineNum = transStartLine; lineNum <= transEndLine; lineNum++) {
      const line = transLines[lineNum];
      const declMatch = line.match(/^%([A-Za-z_$][\w$]*)\s*=\s*(.+)$/);
      if (!declMatch) continue;

      const valueStr = declMatch[2].trim();
      const inferredType = inferType(valueStr);
      if (!inferredType) continue;

      const eqIdx = line.indexOf('=');
      hints.push({
        position: { line: lineNum, character: eqIdx },
        label: `: ${inferredType}`,
        kind: 'type',
      });
    }
  }
```

- [ ] **Step 2: Add `%` quick-fix code action**

In `src/plugins/code-actions.ts`, in the `getCodeActions` function, add a case for `SP203`:

```typescript
      case DiagnosticCode.UndeclaredTransient: {
        const action = fixUndeclaredTransient(diag, workspace);
        if (action) actions.push(action);
        break;
      }
```

Add the fix function:

```typescript
function fixUndeclaredTransient(
  diag: Diagnostic,
  workspace: WorkspaceModel,
): CodeAction | null {
  const match = diag.message.match(/'%(\w+)'/);
  if (!match) return null;

  const varName = match[1];

  const storyTransients = workspace.passages.getStoryTransients();
  if (!storyTransients) return null;

  const storyTransientsUri = storyTransients.uri;
  const text = workspace.documents.getText(storyTransientsUri);
  if (text === undefined) return null;

  const lines = text.split('\n');
  const contentStart = storyTransients.headerEnd.end.line + 1;
  let contentEnd = lines.length;
  for (let i = contentStart; i < lines.length; i++) {
    if (/^::\s+/.test(lines[i])) {
      contentEnd = i;
      break;
    }
  }

  const insertLine = contentEnd;

  return {
    title: `Declare '%${varName}' in StoryTransients`,
    kind: 'quickfix',
    diagnosticCodes: [DiagnosticCode.UndeclaredTransient],
    edits: [{
      uri: storyTransientsUri,
      range: {
        start: { line: insertLine, character: 0 },
        end: { line: insertLine, character: 0 },
      },
      newText: `%${varName} = null\n`,
    }],
  };
}
```

- [ ] **Step 3: Run type check and tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/plugins/inlay-hints.ts src/plugins/code-actions.ts
git commit -m "feat: add % transient inlay hints and code actions"
```

---

### Task 9: Macro Supplements Documentation

**Files:**
- Modify: `src/macro-supplements.json`

- [ ] **Step 1: Update set and unset descriptions**

In `src/macro-supplements.json`, find the `set` macro entry and update its description to mention `%var`:

Change any occurrence of text like:
```
"Supports `$var` (story), `_var` (temporary), and `@var` (local) variables."
```
to:
```
"Supports `$var` (story), `_var` (temporary), `@var` (local), and `%var` (transient) variables."
```

Do the same for the `unset` macro entry.

- [ ] **Step 2: Commit**

```bash
git add src/macro-supplements.json
git commit -m "docs: update macro supplements for % transient variables"
```

---

### Task 10: Integration Tests

**Files:**
- Modify: `test/unit/completions.test.ts` (tests added in Task 3)
- Create: `test/fixtures/transient-variables.tw`

- [ ] **Step 1: Create test fixture**

Create `test/fixtures/transient-variables.tw`:

```
:: StoryVariables
$health = 100

:: StoryTransients
%npcList = []
%agents = { active: true, count: 0 }

:: Start
{set %npcList = ["guard", "merchant"]}
{for @npc of %npcList}
  {@npc}
{/for}
{%agents.count}
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: Run type check and build**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/transient-variables.tw
git commit -m "test: add transient variables fixture and integration tests"
```

---

### Task 11: Final Verification

- [ ] **Step 1: Type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS
