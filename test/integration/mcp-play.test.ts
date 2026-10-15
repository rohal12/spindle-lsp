import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Observation } from '@rohal12/spindle/play';

import { PlaySessions } from '../../src/mcp/play/sessions.js';
import { registerPlayTools } from '../../src/mcp/play/tools.js';

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');
const fixture = join(fixturesDir, 'play', 'story.twee');
/** The version of the @rohal12/spindle the play tools run on. */
const runtimeVersion: string = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', 'node_modules', '@rohal12', 'spindle', 'package.json'),
    'utf-8',
  ),
).version;

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

let open: PlaySessions[] = [];

afterEach(async () => {
  await Promise.all(open.map(sessions => sessions.closeAll()));
  open = [];
});

async function connect(sessions = new PlaySessions()) {
  const server = new McpServer({ name: 't', version: '0' });
  open.push(sessions);
  registerPlayTools(server, sessions);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, sessions, call };
}

type Call = Awaited<ReturnType<typeof connect>>['call'];

async function start(call: Call, story: string): Promise<{ id: string; observation: Observation }> {
  const result = await call('spindle_play_start', { story });
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  const structured = result.structuredContent as { session: string; observation: Observation };
  return { id: structured.session, observation: structured.observation };
}

describe('spindle_play_* tools over MCP', () => {
  it('lists the six play tools', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'spindle_play_goto',
      'spindle_play_observe',
      'spindle_play_start',
      'spindle_play_step',
      'spindle_play_stop',
      'spindle_play_vars',
    ]);
    const step = tools.find(t => t.name === 'spindle_play_step')!;
    const action = (step.inputSchema.properties as Record<string, { description?: string }>).action;
    expect(action.description).toBe('Action id from the observation, e.g. link:Hall');
  });

  it('plays the fixture through every tool', async () => {
    const { call } = await connect();
    const started = await call('spindle_play_start', { story: fixture });
    const { session: id, observation: obs } = started.structuredContent as {
      session: string;
      observation: Observation;
    };
    expect(started.content[0].text).toMatch(/^Session: \w+\n\nPassage: Start/);
    expect(started.content[0].text).not.toContain('Note:');
    expect(started.content[0].text).toContain('Passage: Start');
    expect(started.content[0].text).toContain('HP: 3');

    const observed = await call('spindle_play_observe', { session: id });
    expect(observed.structuredContent).toEqual(obs);
    expect(observed.content[0].text).toMatch(/^Passage: Start/);

    const link = obs.actions.find(a => a.target === 'Hall')!;
    const step = await call('spindle_play_step', { session: id, action: link.id });
    expect(step.structuredContent?.passage).toBe('Hall');
    expect(step.content[0].text).toMatch(/^Passage: Hall/);

    const vars = await call('spindle_play_vars', { session: id, set: { hp: 1 }, get: ['hp'] });
    expect(vars.structuredContent).toEqual({ hp: 1 });
    expect(vars.content[0].text).toBe(JSON.stringify({ hp: 1 }, null, 2));

    const all = await call('spindle_play_vars', { session: id });
    expect(all.structuredContent).toEqual({ name: '?', hp: 1 });

    const go = await call('spindle_play_goto', { session: id, passage: 'Start' });
    expect(go.content[0].text).toContain('HP: 1');
    expect(go.structuredContent?.passage).toBe('Start');

    const stop = await call('spindle_play_stop', { session: id });
    expect(stop.content[0].text).toBe(`stopped: ${id}`);

    const after = await call('spindle_play_observe', { session: id });
    expect(after.isError).toBe(true);
    expect(after.content[0].text).toBe(`unknown or expired session ${id}`);
  });

  it('starts at the given passage', async () => {
    const { call } = await connect();
    const result = await call('spindle_play_start', { story: fixture, passage: 'Hall' });
    expect((result.structuredContent?.observation as Observation).passage).toBe('Hall');
  });

  it('starts from compiled HTML too', async () => {
    const { resolveStoryHtml } = await import('@rohal12/spindle/play');
    const { html } = await resolveStoryHtml({ path: fixture });
    const directory = mkdtempSync(join(tmpdir(), 'spindle-play-html-'));
    try {
      const file = join(directory, 'story.html');
      const older = html.replace(/(<tw-storydata\b[^>]*?\sformat-version=")[^"]*"/, '$10.0.1"');
      expect(older).not.toBe(html);
      writeFileSync(file, older);
      const { call } = await connect();
      const result = await call('spindle_play_start', { story: file });
      expect(result.isError).toBeFalsy();
      const note = `The story was compiled with Spindle 0.0.1; it runs on the installed Spindle ${runtimeVersion}.`;
      expect(result.content[0].text).toMatch(/^Session: \w+\nNote: /);
      expect(result.content[0].text).toContain(`\nNote: ${note}\n`);
      expect(result.structuredContent?.notes).toContain(note);
      expect(result.content[0].text).toContain('HP: 3');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('notes when the project has another Spindle installed than the one that plays it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'spindle-play-project-'));
    try {
      const installed = join(directory, 'node_modules', '@rohal12', 'spindle');
      mkdirSync(installed, { recursive: true });
      writeFileSync(
        join(installed, 'package.json'),
        JSON.stringify({ name: '@rohal12/spindle', version: '0.60.0' }),
      );
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({ name: 'story', dependencies: { '@rohal12/spindle': '0.60.0' } }),
      );
      copyFileSync(fixture, join(directory, 'story.twee'));
      const { call } = await connect();
      const result = await call('spindle_play_start', { story: join(directory, 'story.twee') });
      expect(result.isError, result.content[0].text).toBeFalsy();
      const note = `The project has Spindle 0.60.0 installed; spindle_play runs the story on Spindle ${runtimeVersion}, the copy spindle-lsp ships with.`;
      expect(result.content[0].text).toContain(`\nNote: ${note}\n\nPassage: Start`);
      expect(result.structuredContent?.notes).toEqual([note]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps two sessions isolated', async () => {
    const { call } = await connect();
    const [a, b] = await Promise.all([start(call, fixture), start(call, fixture)]);
    expect(a.id).not.toBe(b.id);
    await call('spindle_play_vars', { session: a.id, set: { hp: 7 } });
    await call('spindle_play_vars', { session: b.id, set: { hp: 9 } });
    const va = await call('spindle_play_vars', { session: a.id, get: ['hp'] });
    const vb = await call('spindle_play_vars', { session: b.id, get: ['hp'] });
    expect(va.structuredContent).toEqual({ hp: 7 });
    expect(vb.structuredContent).toEqual({ hp: 9 });
  });

  it('returns a tool error for an unknown action and keeps the session', async () => {
    const { call } = await connect();
    const { id } = await start(call, fixture);
    const bad = await call('spindle_play_step', { session: id, action: 'nope' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/nope/);
    const observed = await call('spindle_play_observe', { session: id });
    expect(observed.isError).toBeFalsy();
    expect(observed.structuredContent?.passage).toBe('Start');
  });

  it('returns a tool error for goto to an unknown passage and keeps the session', async () => {
    const { call } = await connect();
    const { id } = await start(call, fixture);
    const bad = await call('spindle_play_goto', { session: id, passage: 'Nowhere' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('No passage named "Nowhere"');
    expect((await call('spindle_play_observe', { session: id })).isError).toBeFalsy();
  });

  it('returns a tool error for a story that does not exist', async () => {
    const { call } = await connect();
    const result = await call('spindle_play_start', { story: join(fixturesDir, 'play', 'missing.twee') });
    expect(result.isError).toBe(true);
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it('returns a tool error for an unknown session on every session tool', async () => {
    const { call } = await connect();
    const args = {
      spindle_play_observe: {},
      spindle_play_step: { action: 'link-0' },
      spindle_play_goto: { passage: 'Start' },
      spindle_play_vars: {},
      spindle_play_stop: {},
    };
    for (const [name, extra] of Object.entries(args)) {
      const result = await call(name, { session: 'nope', ...extra });
      expect(result.isError, name).toBe(true);
      expect(result.content[0].text, name).toBe('unknown or expired session nope');
    }
  });

  it('surfaces a step timeout as the tool error and forgets the session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'spindle-play-loop-'));
    try {
      const file = join(directory, 'loop.twee');
      writeFileSync(
        file,
        [
          ':: StoryData',
          '{"ifid": "0F3C4C1A-2B7E-4D8B-9C51-6A2E1F0B7D44", "format": "spindle"}',
          '',
          ':: StoryVariables',
          '$n = 0',
          '',
          ':: Start',
          '[[Loop]]',
          '',
          ':: Loop',
          '{do}while (true) {}{/do}',
          '',
        ].join('\n'),
      );
      const sessions = new PlaySessions({
        load: async () => {
          const play = await import('@rohal12/spindle/play');
          return {
            resolveStoryHtml: play.resolveStoryHtml,
            openPlaySession: options => play.openPlaySession({ ...options, stepTimeoutMs: 3000 }),
          };
        },
      });
      const { call } = await connect(sessions);
      const { id, observation } = await start(call, file);
      const link = observation.actions.find(action => action.target === 'Loop')!;
      const stuck = await call('spindle_play_step', { session: id, action: link.id });
      expect(stuck.isError).toBe(true);
      expect(stuck.content[0].text).toBe(
        'spindle: play session timed out after 3000 ms (the story may be stuck in a loop)',
      );
      const after = await call('spindle_play_observe', { session: id });
      expect(after.isError).toBe(true);
      expect(after.content[0].text).toBe(`unknown or expired session ${id}`);
      expect(sessions.size).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('renders Map, Set and Date variables as JSON', async () => {
    const { call } = await connect();
    const directory = mkdtempSync(join(tmpdir(), 'spindle-play-vars-'));
    try {
      const file = join(directory, 'vars.twee');
      writeFileSync(
        file,
        [
          ':: StoryData',
          '{"ifid": "5B1D2E3F-4A5B-4C6D-8E7F-9A0B1C2D3E4F", "format": "spindle"}',
          '',
          ':: StoryVariables',
          '$bag = new Map()',
          '$seen = new Set()',
          '$when = new Date(0)',
          '',
          ':: StoryInit',
          '{set $bag = new Map([["sword", 1]])}{set $seen = new Set(["Start"])}',
          '',
          ':: Start',
          'Hi',
          '',
        ].join('\n'),
      );
      const { id } = await start(call, file);
      const vars = await call('spindle_play_vars', { session: id, get: ['bag', 'seen', 'when'] });
      expect(vars.isError, vars.content[0].text).toBeFalsy();
      const expected = { bag: { sword: 1 }, seen: ['Start'], when: '1970-01-01T00:00:00.000Z' };
      expect(vars.structuredContent).toEqual(expected);
      expect(JSON.parse(vars.content[0].text)).toEqual(expected);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('resolves a relative story path against cwd', async () => {
    const { call } = await connect();
    const cwd = process.cwd();
    process.chdir(fixturesDir);
    try {
      const result = await call('spindle_play_start', { story: 'play/story.twee' });
      expect(result.isError, result.content[0].text).toBeFalsy();
      expect(result.content[0].text).toContain('Passage: Start');
    } finally {
      process.chdir(cwd);
    }
  });
});
