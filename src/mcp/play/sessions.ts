import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type {
  Observation,
  PlaySession,
  openPlaySession,
  resolveStoryHtml,
} from '@rohal12/spindle/play';

import {
  readInstalledSpindleVersion,
  readSpindlePackageVersion,
} from '../../core/workspace/spindle-version.js';

export type { PlaySession };

/**
 * The first @rohal12/spindle release that ships `@rohal12/spindle/play`.
 * Placeholder until that release exists.
 */
export const PLAY_SPINDLE_VERSION = '0.61.0';

/**
 * The part of `@rohal12/spindle/play` this server uses. It is imported lazily
 * because the installed Spindle may predate that entry.
 */
export interface PlayModule {
  resolveStoryHtml: typeof resolveStoryHtml;
  openPlaySession: typeof openPlaySession;
  /** The version of the @rohal12/spindle that runs the stories, if known. */
  version?: string;
}

const PLAY_SPECIFIER = '@rohal12/spindle/play';

function missingPlayMessage(): string {
  return `spindle_play needs @rohal12/spindle ${PLAY_SPINDLE_VERSION} or later`;
}

/**
 * Whether `error` says that @rohal12/spindle itself is not installed or has no
 * `./play` entry, as opposed to spindle/play failing to load (a dependency of
 * it missing, a syntax error), which is reported as it is.
 */
function isMissingPlay(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof message !== 'string') return false;
  if (code === 'ERR_MODULE_NOT_FOUND') return message.includes("'@rohal12/spindle'");
  if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    return /[\\/]@rohal12[\\/]spindle[\\/]package\.json\b/.test(message);
  }
  return false;
}

function runtimeVersion(locate: () => string): string | undefined {
  try {
    return readSpindlePackageVersion(locate());
  } catch {
    return undefined;
  }
}

/**
 * Import `@rohal12/spindle/play` on demand. The specifier is a variable so the
 * bundler leaves it to the runtime, and the rest of the server still loads
 * when it is missing. `locate` resolves the entry, to read the version of the
 * package it belongs to.
 */
export async function loadPlay(
  importer: () => Promise<unknown> = () => import(PLAY_SPECIFIER),
  locate: () => string = () => import.meta.resolve(PLAY_SPECIFIER),
): Promise<PlayModule> {
  let mod: unknown;
  try {
    mod = await importer();
  } catch (error) {
    if (isMissingPlay(error)) throw new Error(missingPlayMessage());
    throw error;
  }
  if (
    typeof mod !== 'object' ||
    mod === null ||
    typeof (mod as { openPlaySession?: unknown }).openPlaySession !== 'function'
  ) {
    throw new Error(missingPlayMessage());
  }
  const { resolveStoryHtml, openPlaySession } = mod as PlayModule;
  return { resolveStoryHtml, openPlaySession, version: runtimeVersion(locate) };
}

/**
 * A note when the Spindle installed for the story's project is not the one
 * that plays it (spindle-lsp's own dependency), or none.
 */
function runtimeNote(storyPath: string, runtime: string | undefined): string[] {
  if (runtime === undefined) return [];
  const isDirectory = statSync(storyPath, { throwIfNoEntry: false })?.isDirectory() ?? false;
  const installed = readInstalledSpindleVersion(isDirectory ? storyPath : dirname(storyPath));
  if (installed === undefined || installed === runtime) return [];
  return [
    `The project has Spindle ${installed} installed; spindle_play runs the story on ` +
      `Spindle ${runtime}, the copy spindle-lsp ships with.`,
  ];
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
      const path = resolve(process.cwd(), storyPath);
      const { html, notes: storyNotes } = await play.resolveStoryHtml({ path });
      const notes = [...storyNotes, ...runtimeNote(path, play.version)];
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
