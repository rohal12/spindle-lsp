# MCP play tools

The `spindle-lsp mcp` server has six `spindle_play_*` tools that play a story
the way a reader does: start it, read what is on screen, take an action, read
or set variables, stop. They let a coding agent test a story it is writing
without a browser.

Each session runs the story in its own worker thread on
[happy-dom](https://github.com/capricorn86/happy-dom), through
`@rohal12/spindle/play`. A story stuck in a loop can be stopped, and several
stories can run side by side.

## Requirements

The tools need an installed `@rohal12/spindle` release that ships
`@rohal12/spindle/play`: the version in `PLAY_SPINDLE_VERSION`
(`src/mcp/play/sessions.ts`) or later; that is the first release with
`@rohal12/spindle/play`. With an older Spindle the rest of the server works as
before (`spindle_check` and `spindle_format` still need only 0.60.0), and
`spindle_play_start` answers

```
spindle_play needs @rohal12/spindle <PLAY_SPINDLE_VERSION> or later
```

with the constant's value in place of the placeholder. `happy-dom` and
`@rohal12/twee-ts` (which compiles Twee) are dependencies of
`@rohal12/spindle-lsp`, so there is nothing else to install.

## The tools

| Tool                   | Does                                        |
| ---------------------- | ------------------------------------------- |
| `spindle_play_start`   | Opens a session and shows the first passage |
| `spindle_play_observe` | Shows the current passage again             |
| `spindle_play_step`    | Takes one action, such as following a link  |
| `spindle_play_goto`    | Jumps to a passage                          |
| `spindle_play_vars`    | Reads and/or sets story variables           |
| `spindle_play_stop`    | Closes a session                            |

### spindle_play_start

| Input     | Type   | Meaning                                                 |
| --------- | ------ | ------------------------------------------------------- |
| `story`   | string | What to play (see below). Required.                     |
| `passage` | string | A passage to go to once the story has booted. Optional. |

`story` is one of:

- a compiled `.html` (or `.htm`) file, read as it is
- a `.twee` or `.tw` file, compiled
- a glob such as `src/**/*.twee`, compiled as Twee (it must match Twee sources
  only, and it is an error if nothing matches)
- a project directory, compiled with its `twee-ts.config.json` if it has one,
  or as the directory itself if not

A relative path resolves against the server's working directory, as it does
for `spindle_check`. Twee is always compiled with the Spindle format
installed in the project, whatever format the project's config names.

Result: `Session: <id>`, then one `Note: <text>` line for each note, a blank
line, and the [observation](#result-format). A note is not an error. The usual
one says that the story's HTML was built by another Spindle version than the
installed one (`The story was compiled with Spindle 0.9.0; it runs on the
installed Spindle 0.10.2.`); the session runs on the installed version.

If `passage` is given, the first observation is of that passage, reached the
same way as `spindle_play_goto`. If that fails, no session is left open.

`structuredContent` is `{ session, observation, notes }`.

### spindle_play_observe

Input: `session`. Result: the [observation](#result-format) of the current
passage. `structuredContent` is the observation.

### spindle_play_step

| Input     | Type   | Meaning                                                                |
| --------- | ------ | ---------------------------------------------------------------------- |
| `session` | string | The session id. Required.                                              |
| `action`  | string | An action id from the last observation, such as `link:Hall`. Required. |
| `value`   | any    | The value for an input action (a listbox, a textbox, ...).             |

Result: the observation after the action. The step is recorded in the
session's transcript. An action id the story does not offer is an error with
the story's own message, and the session stays open.

### spindle_play_goto

Input: `session` and `passage`. Jumps to the passage and returns its
observation. It is not recorded in the transcript. A passage the story does
not have is an error (`spindle: No passage named "<name>" (in passage
"<current>")`), and so is a special passage such as `StoryInit` (`spindle:
Cannot navigate to special passage "StoryInit".`). The session stays open.

### spindle_play_vars

| Input     | Type     | Meaning                                                           |
| --------- | -------- | ----------------------------------------------------------------- |
| `session` | string   | The session id. Required.                                         |
| `get`     | string[] | Variable names to read, with or without the `$`. All if left out. |
| `set`     | object   | Variables to set, by name.                                        |

With both, it sets first and then reads, so `get` shows the new values.
Setting waits for the story to settle but does not return an observation; use
`spindle_play_observe` to see its effect on the passage.

Result: the variables as JSON text, and the same object as
`structuredContent`. Values are plain JSON: a `Map` becomes an object of its
entries, a `Set` or typed array becomes an array, a `Date` becomes an ISO 8601
string, a reference cycle becomes the string `"[circular]"`, and a value that
cannot be cloned out of the worker (a function, say) comes back as
`"[unserializable: <reason>]"`.

### spindle_play_stop

Input: `session`. Closes the session and stops its worker. Result:
`stopped: <id>`.

## Result format

`start`, `observe`, `step` and `goto` return the same text. It lists what a
reader sees and can do:

```
Passage: Hall   (turn 2)

A hall. Start

Context:
HP: 3

Actions:
1. link:Start  link  "Start" -> Start
```

- `Passage:` is the passage name and the turn, which a link moves forward and
  an input does not.
- The passage text follows.
- `Context:` is the rendered `StoryContext` passage, or `(none)`.
- `Dialogs:` appears only when dialogs are open, one `- <passage>: <text>`
  line each, innermost last.
- `Actions:` numbers the available actions: the id to pass to
  `spindle_play_step`, the type, and a description. A link shows its label and
  `-> target`. An input shows `$variable = value` and, if it has any,
  `options: a, b, c`. A disabled action ends in `(disabled)`. With none, the
  section reads `Actions: none (ending or dead end)`.
- `Errors:` appears only when macro or runtime errors are on screen, one
  `- <message>` line each.

`structuredContent` carries the raw observation object (`passage`, `text`,
`context`, `dialogs`, `actions`, `errors`, `turn`), with the values converted
as described for `spindle_play_vars`.

## Limits

- At most 8 sessions are open at once. Stop one to start another.
- A session that is not used for 30 minutes is closed.
- A call that takes longer than 10 seconds (the `spindle/play` default) closes
  the session. It covers booting too.
- Calls on one session run one at a time.
- Sessions do not share `localStorage`, `sessionStorage` or `navigator`.
- The story's `console.log` goes to the server's stderr, never to the MCP
  channel on stdout.

When the client disconnects or the server is stopped (`SIGINT`, `SIGTERM`),
every open session is closed, so no worker outlives the server.

## Errors

Errors come back as tool results with `isError: true` and the message as
text. A tool never throws out of the server.

| Message                                                                           | When                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `too many open play sessions (8); stop one with spindle_play_stop`                | `start` with 8 sessions open                            |
| `unknown or expired session <id>`                                                 | An id that was never issued, stopped, expired or closed |
| `spindle_play needs @rohal12/spindle <PLAY_SPINDLE_VERSION> or later`             | `start` with a Spindle that has no `spindle/play`       |
| `play sessions are shutting down`                                                 | `start` while the server is closing                     |
| `spindle: play session timed out after <n> ms (the story may be stuck in a loop)` | A call exceeded the timeout; the session is closed      |
| `spindle: play session is closed`                                                 | A call queued behind a timeout                          |
| `spindle: no story files match <pattern>`                                         | `start` with a glob that matches nothing                |
| `file:line: message`, one per error                                               | `start` on Twee that does not compile                   |

After a timeout the session id is forgotten, so the next call with it reports
`unknown or expired session <id>`. Messages that start with `spindle:` come
from `@rohal12/spindle/play` and are passed through as they are; so are the
story's own messages, such as an unknown action id.
