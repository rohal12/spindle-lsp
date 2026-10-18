import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Observation } from '@rohal12/spindle/play';
import { z } from 'zod';

import { formatObservation } from './format-observation.js';
import { toJsonSafe } from './json-safe.js';
import type { PlaySessions } from './sessions.js';

/** A tool result: text for the agent and `data` (already JSON-safe) as structured content. */
function result(text: string, data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: data as Record<string, unknown>,
  };
}

function observationResult(observation: Observation): CallToolResult {
  return result(formatObservation(observation), toJsonSafe(observation));
}

/** Run a handler, turning anything it throws into an MCP tool error. */
async function guarded(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: 'text', text }] };
  }
}

const sessionId = z.string().describe('Session id returned by spindle_play_start');

/** Register the spindle_play_* tools, which play a story through `sessions`. */
export function registerPlayTools(server: McpServer, sessions: PlaySessions): void {
  server.tool(
    'spindle_play_start',
    'Execute a trusted Spindle story headlessly with host file, environment and command access. Requires SPINDLE_LSP_TRUSTED_PLAY=1 in the server environment. Returns a session id and what the reader sees.',
    {
      story: z
        .string()
        .describe('Path to compiled .html, a .twee/.tw file, a glob or a project directory'),
      passage: z.string().optional().describe('Passage to go to after boot'),
    },
    args =>
      guarded(async () => {
        const started = await sessions.start(args.story, args.passage);
        const header = [
          `Session: ${started.session}`,
          ...started.notes.map(note => `Note: ${note}`),
        ].join('\n');
        const text = `${header}\n\n${formatObservation(started.observation)}`;
        return result(text, toJsonSafe(started));
      }),
  );

  server.tool(
    'spindle_play_observe',
    'Show the current passage, context, dialogs, available actions and errors of a play session.',
    { session: sessionId },
    args => guarded(async () => observationResult(await sessions.get(args.session).observe())),
  );

  server.tool(
    'spindle_play_step',
    'Take an action (by id from the observation) in a play session.',
    {
      session: sessionId,
      action: z.string().describe('Action id from the observation, e.g. link:Hall'),
      value: z.unknown().optional().describe('Value for an input action (listbox, textbox, ...)'),
    },
    args =>
      guarded(async () =>
        observationResult(await sessions.get(args.session).step(args.action, args.value)),
      ),
  );

  server.tool(
    'spindle_play_goto',
    'Jump to a passage in a play session.',
    { session: sessionId, passage: z.string().describe('Passage name') },
    args =>
      guarded(async () => observationResult(await sessions.get(args.session).goto(args.passage))),
  );

  server.tool(
    'spindle_play_vars',
    'Read and/or set story variables in a play session. Sets first, then reads.',
    {
      session: sessionId,
      get: z
        .array(z.string())
        .optional()
        .describe('Variable names to read (with or without $); all when left out'),
      set: z.record(z.string(), z.unknown()).optional().describe('Variables to set first'),
    },
    args =>
      guarded(async () => {
        const session = sessions.get(args.session);
        if (args.set) await session.set(args.set);
        const vars = toJsonSafe(await session.get(args.get));
        return result(JSON.stringify(vars, null, 2), vars);
      }),
  );

  server.tool(
    'spindle_play_stop',
    'Stop a play session and free its worker.',
    { session: sessionId },
    args =>
      guarded(async () => {
        await sessions.stop(args.session);
        return result(`stopped: ${args.session}`, { session: args.session });
      }),
  );
}
