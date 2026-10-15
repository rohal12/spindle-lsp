import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
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

function makeSessions(options: { max?: number; idleMs?: number } = {}) {
  const fake = fakePlay();
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

describe('loadPlay', () => {
  it('reports the version message when spindle/play is missing', async () => {
    await expect(
      loadPlay(async () => {
        throw new Error('Cannot find module');
      }),
    ).rejects.toThrow(`spindle_play needs @rohal12/spindle ${PLAY_SPINDLE_VERSION} or later`);
  });

  it('reports the version message when openPlaySession is missing', async () => {
    await expect(loadPlay(async () => ({}))).rejects.toThrow(
      `spindle_play needs @rohal12/spindle ${PLAY_SPINDLE_VERSION} or later`,
    );
  });

  it('returns the module when it has openPlaySession', async () => {
    const mod = { openPlaySession: () => {}, resolveStoryHtml: () => {} };
    await expect(loadPlay(async () => mod)).resolves.toBe(mod);
  });
});
