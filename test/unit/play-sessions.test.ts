import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PLAY_SPINDLE_VERSION,
  PlaySessions,
  loadPlay,
  type PlayModule,
} from '../../src/mcp/play/sessions.js';

interface StubSession {
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
}

function fakePlay() {
  const stubs: StubSession[] = [];
  const resolveStoryHtml = vi.fn(async () => ({ html: 'x', notes: ['n'] }));
  const openPlaySession = vi.fn(async () => {
    const stub: StubSession = {
      closed: false,
      close: vi.fn(async () => {
        stub.closed = true;
      }),
      goto: vi.fn(async (passage: string) => ({ passage })),
      observe: vi.fn(async () => ({ passage: 'Start' })),
    };
    stubs.push(stub);
    return stub;
  });
  const play = { resolveStoryHtml, openPlaySession } as unknown as PlayModule;
  return { play, stubs, resolveStoryHtml, openPlaySession };
}

function makeSessions(options: { max?: number; idleMs?: number; version?: string } = {}) {
  const fake = fakePlay();
  if (options.version !== undefined) fake.play.version = options.version;
  const sessions = new PlaySessions({
    load: async () => fake.play,
    ...options,
  });
  return { sessions, ...fake };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PlaySessions', () => {
  it('starts a session and returns the first observation and notes', async () => {
    const { sessions } = makeSessions();
    const r = await sessions.start('story.twee');
    expect(r).toMatchObject({
      observation: { passage: 'Start' },
      notes: ['n'],
    });
    expect(sessions.get(r.session)).toBeDefined();
    expect(r.session).toMatch(/^[0-9a-f]{8}$/);
    expect(sessions.size).toBe(1);
  });

  it('goes to the given passage on start', async () => {
    const { sessions, stubs } = makeSessions();
    const r = await sessions.start('s', 'Hall');
    expect(stubs[0]!.goto).toHaveBeenCalledWith('Hall');
    expect(stubs[0]!.observe).not.toHaveBeenCalled();
    expect(r.observation).toMatchObject({ passage: 'Hall' });
  });

  it('resolves a relative path against process.cwd()', async () => {
    const { sessions, resolveStoryHtml, openPlaySession } = makeSessions();
    await sessions.start('story.twee');
    expect(resolveStoryHtml).toHaveBeenCalledWith({
      path: resolve(process.cwd(), 'story.twee'),
    });
    expect(openPlaySession).toHaveBeenCalledWith({ html: 'x' });
  });

  it('refuses a ninth session', async () => {
    const { sessions } = makeSessions();
    for (let i = 0; i < 8; i++) await sessions.start('s');
    await expect(sessions.start('s')).rejects.toThrow(
      'too many open play sessions (8); stop one with spindle_play_stop',
    );
    expect(sessions.size).toBe(8);
  });

  it('counts in-flight starts toward the cap', async () => {
    const { sessions } = makeSessions({ max: 2 });
    const results = await Promise.allSettled([
      sessions.start('s'),
      sessions.start('s'),
      sessions.start('s'),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    expect(sessions.size).toBe(2);
  });

  it('closes the session and rethrows when the first observation fails', async () => {
    const { sessions, stubs, openPlaySession } = makeSessions();
    openPlaySession.mockImplementationOnce(async () => {
      const stub: StubSession = {
        closed: false,
        close: vi.fn(async () => {
          stub.closed = true;
        }),
        goto: vi.fn(),
        observe: vi.fn(async () => {
          throw new Error('boom');
        }),
      };
      stubs.push(stub);
      return stub;
    });
    await expect(sessions.start('s')).rejects.toThrow('boom');
    expect(stubs[0]!.close).toHaveBeenCalled();
    expect(sessions.size).toBe(0);
  });

  it('expires idle sessions and closes them', async () => {
    vi.useFakeTimers();
    const { sessions, stubs } = makeSessions();
    const r = await sessions.start('s');
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(() => sessions.get(r.session)).toThrow(`unknown or expired session ${r.session}`);
    expect(stubs[0]!.close).toHaveBeenCalled();
    expect(sessions.size).toBe(0);
  });

  it('get resets the idle timer', async () => {
    vi.useFakeTimers();
    const { sessions, stubs } = makeSessions();
    const r = await sessions.start('s');
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    sessions.get(r.session);
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(sessions.get(r.session)).toBeDefined();
    expect(stubs[0]!.close).not.toHaveBeenCalled();
  });

  it('forgets a session whose handle is closed (timed out)', async () => {
    const { sessions, stubs } = makeSessions();
    const r = await sessions.start('s');
    stubs[0]!.closed = true;
    expect(() => sessions.get(r.session)).toThrow(`unknown or expired session ${r.session}`);
    expect(sessions.size).toBe(0);
  });

  it('throws for an id that never existed', () => {
    const { sessions } = makeSessions();
    expect(() => sessions.get('nope')).toThrow('unknown or expired session nope');
  });

  it('stop closes and forgets a session', async () => {
    const { sessions, stubs } = makeSessions();
    const r = await sessions.start('s');
    await sessions.stop(r.session);
    expect(stubs[0]!.close).toHaveBeenCalled();
    expect(sessions.size).toBe(0);
    await expect(sessions.stop(r.session)).rejects.toThrow(
      `unknown or expired session ${r.session}`,
    );
  });

  it('does not count closed sessions toward the cap or size', async () => {
    const { sessions, stubs } = makeSessions({ max: 1 });
    await sessions.start('s');
    stubs[0]!.closed = true;
    expect(sessions.size).toBe(0);
    await expect(sessions.start('s')).resolves.toMatchObject({ notes: ['n'] });
    expect(sessions.size).toBe(1);
  });

  it('prunes a closed session at start even before size is read', async () => {
    const { sessions, stubs } = makeSessions({ max: 1 });
    await sessions.start('s');
    stubs[0]!.closed = true;
    await expect(sessions.start('s')).resolves.toBeDefined();
  });

  it('stop forgets the session even when close() rejects, and rethrows', async () => {
    const { sessions, stubs } = makeSessions();
    const r = await sessions.start('s');
    stubs[0]!.close.mockRejectedValueOnce(new Error('worker gone'));
    await expect(sessions.stop(r.session)).rejects.toThrow('worker gone');
    expect(sessions.size).toBe(0);
    expect(() => sessions.get(r.session)).toThrow('unknown or expired session');
  });

  it('closes a session whose start finished after closeAll and rejects', async () => {
    const { sessions, stubs, openPlaySession } = makeSessions();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const open = openPlaySession.getMockImplementation()!;
    openPlaySession.mockImplementationOnce(async (...args: []) => {
      await gate;
      return open(...args);
    });
    const pending = sessions.start('s');
    const settled = expect(pending).rejects.toThrow('play sessions are shutting down');
    await sessions.closeAll();
    release();
    await settled;
    expect(stubs[0]!.close).toHaveBeenCalled();
    expect(sessions.size).toBe(0);
  });

  it('rejects starts after closeAll', async () => {
    const { sessions, openPlaySession } = makeSessions();
    await sessions.closeAll();
    await expect(sessions.start('s')).rejects.toThrow('play sessions are shutting down');
    expect(openPlaySession).not.toHaveBeenCalled();
  });

  it('closeAll closes every session', async () => {
    const { sessions, stubs } = makeSessions();
    await sessions.start('s');
    await sessions.start('s');
    await sessions.closeAll();
    expect(stubs.every(s => s.close.mock.calls.length === 1)).toBe(true);
    expect(sessions.size).toBe(0);
  });
});

/** A temporary directory with `@rohal12/spindle` of `version` installed in its node_modules. */
function projectWithSpindle(version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'spindle-play-project-'));
  const pkg = join(root, 'node_modules', '@rohal12', 'spindle');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@rohal12/spindle', version }));
  mkdirSync(join(root, 'story'));
  return root;
}

describe('PlaySessions runtime version note', () => {
  const note = (installed: string, runtime: string) =>
    `The project has Spindle ${installed} installed; spindle_play runs the story on Spindle ${runtime}, the copy spindle-lsp ships with.`;
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('notes a project Spindle that differs from the play runtime', async () => {
    root = projectWithSpindle('0.1.0');
    const { sessions } = makeSessions({ version: '9.9.9' });
    const r = await sessions.start(join(root, 'story', 'story.twee'));
    expect(r.notes).toEqual(['n', note('0.1.0', '9.9.9')]);
  });

  it('looks for the project Spindle from a story directory itself', async () => {
    root = projectWithSpindle('0.1.0');
    const story = join(root, 'story');
    mkdirSync(join(story, 'node_modules', '@rohal12', 'spindle'), { recursive: true });
    writeFileSync(
      join(story, 'node_modules', '@rohal12', 'spindle', 'package.json'),
      JSON.stringify({ name: '@rohal12/spindle', version: '0.2.0' }),
    );
    const { sessions } = makeSessions({ version: '9.9.9' });
    const r = await sessions.start(story);
    expect(r.notes).toEqual(['n', note('0.2.0', '9.9.9')]);
  });

  it('adds no note when the versions match, none is installed or the runtime is unknown', async () => {
    root = projectWithSpindle('9.9.9');
    const story = join(root, 'story', 'story.twee');
    expect((await makeSessions({ version: '9.9.9' }).sessions.start(story)).notes).toEqual(['n']);
    expect((await makeSessions().sessions.start(story)).notes).toEqual(['n']);
    const bare = mkdtempSync(join(tmpdir(), 'spindle-play-bare-'));
    try {
      const r = await makeSessions({ version: '9.9.9' }).sessions.start(join(bare, 's.twee'));
      expect(r.notes).toEqual(['n']);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

const versionMessage = `spindle_play needs @rohal12/spindle ${PLAY_SPINDLE_VERSION} or later`;

function codeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('loadPlay', () => {
  const play = { openPlaySession: () => {}, resolveStoryHtml: () => {} };
  const noLocation = () => {
    throw new Error('not resolvable');
  };

  it('reports the version message when @rohal12/spindle is not installed', async () => {
    const error = codeError(
      'ERR_MODULE_NOT_FOUND',
      "Cannot find package '@rohal12/spindle' imported from /x/dist/bin.js",
    );
    await expect(loadPlay(async () => Promise.reject(error), noLocation)).rejects.toThrow(
      versionMessage,
    );
  });

  it('reports the version message when the installed Spindle has no ./play export', async () => {
    const error = codeError(
      'ERR_PACKAGE_PATH_NOT_EXPORTED',
      `Package subpath './play' is not defined by "exports" in /p/node_modules/@rohal12/spindle/package.json imported from /x/dist/bin.js`,
    );
    await expect(loadPlay(async () => Promise.reject(error), noLocation)).rejects.toThrow(
      versionMessage,
    );
  });

  it('rethrows any other failure to load spindle/play', async () => {
    const nested = codeError(
      'ERR_MODULE_NOT_FOUND',
      "Cannot find package 'devalue' imported from /p/node_modules/@rohal12/spindle/dist/pkg/play.js",
    );
    const syntax = new SyntaxError('Unexpected token');
    for (const error of [nested, syntax, new Error('Cannot find module')]) {
      await expect(loadPlay(async () => Promise.reject(error), noLocation)).rejects.toBe(error);
    }
  });

  it('reports the version message when openPlaySession is missing', async () => {
    await expect(loadPlay(async () => ({}), noLocation)).rejects.toThrow(versionMessage);
  });

  it('returns the module functions and the runtime version of the resolved package', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spindle-play-runtime-'));
    try {
      mkdirSync(join(root, 'dist', 'pkg'), { recursive: true });
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: '@rohal12/spindle', version: '1.2.3' }),
      );
      writeFileSync(join(root, 'dist', 'pkg', 'package.json'), JSON.stringify({ type: 'module' }));
      const url = pathToFileURL(join(root, 'dist', 'pkg', 'play.js')).href;
      const loaded = await loadPlay(
        async () => play,
        () => url,
      );
      expect(loaded).toEqual({ ...play, version: '1.2.3' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves the runtime version unknown when spindle/play cannot be located', async () => {
    await expect(loadPlay(async () => play, noLocation)).resolves.toEqual({
      ...play,
      version: undefined,
    });
  });

  it('reads the version of the @rohal12/spindle this server resolves by default', async () => {
    const pkg = join(import.meta.dirname, '..', '..', 'node_modules', '@rohal12', 'spindle');
    const expected = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf-8')).version;
    await expect(loadPlay()).resolves.toMatchObject({ version: expected });
  });
});
