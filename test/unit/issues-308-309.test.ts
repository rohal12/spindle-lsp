import { afterEach, expect, it, vi } from 'vitest';
import { discoverMacros } from '@rohal12/spindle/tooling';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { VariableTracker } from '../../src/core/workspace/variable-tracker.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const models: WorkspaceModel[] = [];
afterEach(() => {
  for (const model of models.splice(0)) model.dispose();
  vi.restoreAllMocks();
});

it.each([128, 256])('bounds script-body lookups for %i passages on initialization and edits (#308)', count => {
  const uri = 'file:///scripts.tw';
  const model = new WorkspaceModel();
  models.push(model);
  const get = model.markup.get.bind(model.markup);
  const instrumented = new WeakSet<object>();
  let reads = 0;
  vi.spyOn(model.markup, 'get').mockImplementation(uri => {
    const doc = get(uri);
    for (const markup of doc?.passages ?? []) {
      if (instrumented.has(markup)) continue;
      instrumented.add(markup);
      const passage = markup.passage;
      Object.defineProperty(markup, 'passage', { get() { reads++; return passage; } });
    }
    return doc;
  });
  const body = (description: string) => `Story.defineMacro({name:"indexed",description:"${description}",render(){}});`;
  const source = (description: string) => ':: StoryVariables\n'
    + Array.from({ length: count }, (_, i) => `:: Script${i} [script]\n${i === count - 1 ? body(description) : 'void 0;'}\n`).join('');
  for (const description of ['initial', 'edited']) {
    reads = 0;
    if (description === 'initial') model.initialize(new Map([[uri, source(description)]]));
    else model.documents.update(uri, source(description));
    model.ensureCurrent();
    const [expected] = discoverMacros(body(description));
    expect(model.macros.getMacro(expected.name)?.description).toBe(expected.description);
    expect(reads).toBeLessThan(count * 20);
  }
});

it.each([64, 128])('shares root-write aggregation across cold and warm diagnostics for %i files (#309)', count => {
  const files = new Map([['file:///vars.tw', ':: StoryVariables\n'
    + Array.from({ length: count * 10 }, (_, i) => `$v${i} = 0`).join('\n')]]);
  for (let i = 0; i < count; i++) {
    files.set(`file:///p${i}.tw`, `:: P${i}\n{set `
      + Array.from({ length: 10 }, (_, j) => `$v${i * 10 + j} = 1`).join(';') + '}');
  }
  const model = new WorkspaceModel();
  models.push(model);
  model.initialize(files);
  // Count visits to the actual write sets without a production instrumentation API.
  const { rootWritesByUri } = model.variables as unknown as { rootWritesByUri: Map<string, Set<string>> };
  let visits = 0;
  for (const writes of rootWritesByUri.values()) {
    const iterator = writes[Symbol.iterator].bind(writes);
    vi.spyOn(writes, Symbol.iterator).mockImplementation(function* () {
      for (const write of iterator()) { visits++; yield write; }
    });
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const uri of files.keys()) expect(computeDiagnostics(uri, model)).toEqual([]);
  }
  expect(visits).toBeLessThanOrEqual(count * 10);
});

it('refreshes shared root writes after scans and removals, preserving overlapping writers and scopes (#309)', () => {
  const tracker = new VariableTracker();
  tracker.parseStoryVariables('$arr = []');
  tracker.parseStoryTransients('%arr = []');
  const uri = 'file:///read.tw';
  tracker.scanDocument(uri, ':: Read\n{$arr.field} {%arr.field}');
  const warnings = () => tracker.getArrayMemberAccesses(uri).map(access => access.sigil + access.name);
  expect(warnings()).toEqual(['$arr', '%arr']);
  tracker.scanDocument('file:///a.tw', ':: A\n{set $arr = {field: 1}}');
  tracker.scanDocument('file:///b.tw', ':: B\n{set $arr = {field: 2}; %arr = {field: 3}}');
  expect(warnings()).toEqual([]);
  tracker.removeDocument('file:///a.tw');
  expect(warnings()).toEqual([]);
  tracker.scanDocument('file:///b.tw', ':: B\n{set %arr = {field: 3}}');
  expect(warnings()).toEqual(['$arr']);
  tracker.scanDocument('file:///b.tw', ':: B\nNo assignments');
  expect(warnings()).toEqual(['$arr', '%arr']);
  tracker.scanDocument('file:///b.tw', ':: B\n{set $arr = {field: 2}; %arr = {field: 3}}');
  expect(warnings()).toEqual([]);
  tracker.removeDocument('file:///b.tw');
  expect(warnings()).toEqual(['$arr', '%arr']);
});
