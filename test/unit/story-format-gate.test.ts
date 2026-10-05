import { describe, it, expect } from 'vitest';
import type { Connection } from 'vscode-languageserver';
import { gateConnection } from '../../src/server/story-format-gate.js';
import { allPlugins } from '../../src/plugins/index.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';

interface Registration {
  method: string;
  handler: (...args: unknown[]) => unknown;
}

/**
 * A stand-in connection that records every method called on it (with its
 * dotted path, e.g. `languages.semanticTokens.on`) and the first argument.
 */
function recordingConnection(): { connection: Connection; calls: Registration[] } {
  const calls: Registration[] = [];
  const node = (path: string[]): unknown => new Proxy(function () { /* recorder */ }, {
    get: (_target, prop) => node([...path, String(prop)]),
    apply: (_target, _this, args: unknown[]) => {
      calls.push({ method: path.join('.'), handler: args[0] as Registration['handler'] });
    },
  });
  return { connection: node([]) as Connection, calls };
}

const story = ':: StoryData\n{"format": "SugarCube"}\n\n:: Start\n{if $x}<b>[[Next]]</b>{/if}\n\n:: Next\nEnd.\n';
const uri = 'file:///story.twee';
const textDocument = { uri };
const position = { line: 4, character: 2 };
const range = { start: { line: 0, character: 0 }, end: { line: 7, character: 0 } };

/** Plausible params for every request a plugin registers. */
const params = {
  textDocument,
  position,
  range,
  query: '',
  newName: 'Renamed',
  context: { diagnostics: [], triggerKind: 1, includeDeclaration: true },
  options: { tabSize: 2, insertSpaces: true },
};

function initializeAll(connection: Connection, workspace: WorkspaceModel): void {
  for (const plugin of allPlugins) {
    plugin.initialize({ connection, workspace, config: {} });
  }
}

describe('gateConnection', () => {
  it('passes handlers through while enabled and answers null while disabled', () => {
    const { connection, calls } = recordingConnection();
    let enabled = true;
    const gated = gateConnection(connection, () => enabled);

    gated.onHover(() => ({ contents: 'hi' }));
    gated.languages.semanticTokens.on(() => ({ data: [1] }));
    gated.languages.inlayHint.on(() => []);

    expect(calls.map(c => c.method)).toEqual([
      'onHover',
      'languages.semanticTokens.on',
      'languages.inlayHint.on',
    ]);
    expect(calls.map(c => c.handler())).toEqual([{ contents: 'hi' }, { data: [1] }, []]);
    enabled = false;
    expect(calls.map(c => c.handler())).toEqual([null, null, null]);
  });

  it('leaves other connection methods alone', () => {
    const { connection, calls } = recordingConnection();
    const gated = gateConnection(connection, () => false);
    const send = { uri, diagnostics: [] };
    gated.sendDiagnostics(send);
    expect(calls).toEqual([{ method: 'sendDiagnostics', handler: send }]);
  });

  it('gates every request every plugin registers', async () => {
    const workspace = new WorkspaceModel();
    workspace.initialize(new Map([[uri, story]]));
    expect(workspace.isSpindleProject()).toBe(false);

    const { connection, calls } = recordingConnection();
    initializeAll(gateConnection(connection, () => workspace.isSpindleProject()), workspace);

    const registrations = calls.filter(c => c.method !== 'sendDiagnostics');
    expect(registrations.length).toBeGreaterThanOrEqual(17);
    for (const { method, handler } of registrations) {
      expect(await handler(params, {}, undefined, undefined), method).toBeNull();
    }
    workspace.dispose();
  });

  it('answers each request while the project is Spindle (sanity check of the params)', async () => {
    const workspace = new WorkspaceModel();
    workspace.initialize(new Map([[uri, story.replace('SugarCube', 'spindle')]]));

    const { connection, calls } = recordingConnection();
    initializeAll(gateConnection(connection, () => workspace.isSpindleProject()), workspace);

    // Handlers run (no throw) and at least semantic tokens and symbols answer
    const results = new Map<string, unknown>();
    for (const { method, handler } of calls) {
      results.set(method, await handler(params, {}, undefined, undefined));
    }
    expect(results.get('languages.semanticTokens.on')).toEqual({ data: expect.any(Array) });
    expect(results.get('onDocumentSymbol')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Start' }),
    ]));
    workspace.dispose();
  });
});
