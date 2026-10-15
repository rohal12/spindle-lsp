import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import type { Observation } from '@rohal12/spindle';
import type { TranscriptEntry } from '@rohal12/spindle/headless';

/**
 * The first @rohal12/spindle release that ships `@rohal12/spindle/play`.
 * Placeholder until that release exists.
 */
export const PLAY_SPINDLE_VERSION = '0.61.0';

/** Handle on one booted story, as `@rohal12/spindle/play` returns it. */
export interface PlaySession {
  observe(): Promise<Observation>;
  step(id: string, value?: unknown): Promise<Observation>;
  goto(passage: string): Promise<Observation>;
  get(names?: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  transcript(): Promise<TranscriptEntry[]>;
  close(): Promise<void>;
  readonly closed: boolean;
}

/**
 * The part of `@rohal12/spindle/play` this server uses. Declared structurally
 * because the installed Spindle may predate that entry (it is loaded lazily).
 */
export interface PlayModule {
  resolveStoryHtml(
    input: { path: string } | { html: string },
  ): Promise<{ html: string; notes: string[] }>;
  openPlaySession(options: { html: string; stepTimeoutMs?: number }): Promise<PlaySession>;
}

const PLAY_SPECIFIER = '@rohal12/spindle/play';

function missingPlayMessage(): string {
  return `spindle_play needs @rohal12/spindle ${PLAY_SPINDLE_VERSION} or later`;
}

/**
 * Import `@rohal12/spindle/play` on demand. The specifier is a variable so the
 * bundler leaves it to the runtime and the type checker does not need the
 * entry to exist in the installed Spindle.
 */
export async function loadPlay(
  importer: () => Promise<unknown> = () => import(PLAY_SPECIFIER),
): Promise<PlayModule> {
  let mod: unknown;
  try {
    mod = await importer();
  } catch {
    throw new Error(missingPlayMessage());
  }
  if (
    typeof mod !== 'object' ||
    mod === null ||
    typeof (mod as { openPlaySession?: unknown }).openPlaySession !== 'function'
  ) {
    throw new Error(missingPlayMessage());
  }
  return mod as PlayModule;
}

export interface PlaySessionsOptions {
  load?: () => Promise<PlayModule>;
  /** Most sessions open at once. Default 8. */
  max?: number;
  /** Idle time before a session is closed. Default 30 minutes. */
  idleMs?: number;
}

interface Entry {
  session: PlaySession;
  timer: NodeJS.Timeout;
}

/** Owns the open play sessions: ids, the cap, idle expiry and shutdown. */
export class PlaySessions {
  private readonly entries = new Map<string, Entry>();
  private readonly load: () => Promise<PlayModule>;
  private readonly max: number;
  private readonly idleMs: number;
  /** Sessions being opened; they count toward the cap before they are registered. */
  private starting = 0;
  /** Set by closeAll(): no session may be registered after shutdown. */
  private closing = false;

  constructor(options: PlaySessionsOptions = {}) {
    this.load = options.load ?? loadPlay;
    this.max = options.max ?? 8;
    this.idleMs = options.idleMs ?? 1_800_000;
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  async start(
    storyPath: string,
    passage?: string,
  ): Promise<{ session: string; observation: Observation; notes: string[] }> {
    if (this.closing) throw shuttingDown();
    this.prune();
    if (this.entries.size + this.starting >= this.max) {
      throw new Error(`too many open play sessions (${this.max}); stop one with spindle_play_stop`);
    }
    this.starting++;
    try {
      const play = await this.load();
      const { html, notes } = await play.resolveStoryHtml({
        path: resolve(process.cwd(), storyPath),
      });
      const session = await play.openPlaySession({ html });
      let observation: Observation;
      try {
        observation = passage === undefined ? await session.observe() : await session.goto(passage);
        // closeAll() ran while this start was in flight.
        if (this.closing) throw shuttingDown();
      } catch (error) {
        await session.close().catch(() => {});
        throw error;
      }
      const id = this.newId();
      this.entries.set(id, { session, timer: this.armTimer(id) });
      return { session: id, observation, notes };
    } finally {
      this.starting--;
    }
  }

  get(id: string): PlaySession {
    const entry = this.entries.get(id);
    if (!entry) throw unknownSession(id);
    if (entry.session.closed) {
      this.forget(id);
      throw unknownSession(id);
    }
    clearTimeout(entry.timer);
    entry.timer = this.armTimer(id);
    return entry.session;
  }

  async stop(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw unknownSession(id);
    this.forget(id);
    await entry.session.close();
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) clearTimeout(entry.timer);
    await Promise.all(entries.map(entry => entry.session.close().catch(() => {})));
  }

  private newId(): string {
    let id: string;
    do id = randomBytes(4).toString('hex');
    while (this.entries.has(id));
    return id;
  }

  private armTimer(id: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const entry = this.entries.get(id);
      if (!entry) return;
      this.forget(id);
      entry.session.close().catch(() => {});
    }, this.idleMs);
    timer.unref();
    return timer;
  }

  /** Forget sessions whose handle closed on its own (e.g. a step timed out). */
  private prune(): void {
    for (const [id, entry] of this.entries) {
      if (entry.session.closed) this.forget(id);
    }
  }

  private forget(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(id);
  }
}

function shuttingDown(): Error {
  return new Error('play sessions are shutting down');
}

function unknownSession(id: string): Error {
  return new Error(`unknown or expired session ${id}`);
}
