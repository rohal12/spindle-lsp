# MCP play tools

The `spindle-lsp mcp` server has six `spindle_play_*` tools that play a story
the way a reader does: start it, read what is on screen, take an action, read
or set variables, stop. They let a coding agent test a story it is writing
without a browser.

Each session runs the story in its own worker thread on
[happy-dom](https://github.com/capricorn86/happy-dom), through
`@rohal12/spindle/play`. A story stuck in a loop can be stopped, and several
stories can run side by side.

## Host-code trust

Play execution is disabled by default. Stories execute JavaScript with the MCP
server account's privileges, including reading and writing host files, reading
environment variables and running commands. Worker threads and timeouts do not
isolate that authority. Only enable play for stories and project code you trust,
including any scripts and dependencies used to compile them.

To opt in, set `SPINDLE_LSP_TRUSTED_PLAY=1` in the MCP server's environment and
restart the server, for example:

```sh
SPINDLE_LSP_TRUSTED_PLAY=1 npx @rohal12/spindle-lsp mcp
```

For an MCP client configuration, add `"SPINDLE_LSP_TRUSTED_PLAY": "1"` to the
server's `env` object. The setting applies to every story played by that server.
It cannot be enabled through a tool argument or a story's project config. Without
it, `spindle_play_start` returns a tool error before loading or compiling the
story; checks and formatting remain available.

Formatting reads JSON/YAML Prettier settings by default, including object settings
in `package.json` and `package.yaml`. It skips executable configs, shareable config
imports and plugins. To allow those for a trusted project, set
`SPINDLE_LSP_TRUSTED_FORMAT=1` in the host environment before starting the CLI,
LSP or MCP server. They execute with your account's host privileges. This setting
is independent of play trust and cannot be granted by a tool argument or project
config. Other config formats (including JSON5 and TOML) also require this opt-in.
The formatter preserves the document's line-ending style regardless of Prettier's
`endOfLine` setting.

Directory and glob scans for checks and formatting skip symbolic links, including
paths through linked directories. To check or format a linked file, select its
file path explicitly; formatting then writes to that link's target. The same
selection policy applies to the CLI and MCP tools.

## Requirements

Node.js 24 or later and `@rohal12/spindle-lsp` itself. `@rohal12/spindle` (a release
with `@rohal12/spindle/play`, the version in `PLAY_SPINDLE_VERSION` in
`src/mcp/play/sessions.ts` or later), `happy-dom` and `@rohal12/twee-ts` (which
compiles Twee) are its dependencies, so `npx @rohal12/spindle-lsp mcp` and the
Claude Code plugin get them too. The stories run on that copy of Spindle, not
on the one installed in the story's project; the project's copy only decides
whether `spindle_play_start` adds a [note](#spindle_play_start).

If `@rohal12/spindle` cannot be found, or the one found has no
`@rohal12/spindle/play` entry, `spindle_play_start` answers

```
spindle_play needs @rohal12/spindle <PLAY_SPINDLE_VERSION> or later
```

with the constant's value in place of the placeholder. Any other failure to
load `@rohal12/spindle/play` (a missing dependency of it, say) is reported
with its own message. The rest of the server works either way.

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
for `spindle_check`. Twee is compiled and run by spindle-lsp's own
`@rohal12/spindle`, with its Spindle format, whatever format the project's
config names and whatever Spindle the project has installed.

Result: `Session: <id>`, then one `Note: <text>` line for each note, a blank
line, and the [observation](#result-format). A note is not an error. There
are two:

- The story's HTML was built by another Spindle version than the one that runs
  it. "Installed" in it means spindle-lsp's own copy:

  ```
  The story was compiled with Spindle 0.9.0; it runs on the installed Spindle 0.10.2.
  ```

- The project has another `@rohal12/spindle` installed (found in
  `node_modules` from the story's directory up) than spindle-lsp's own copy.
  Only a declared Spindle counts: a `package.json` in the directory holding
  that `node_modules`, or between it and the story, lists `@rohal12/spindle`
  in a dependency field, or one of those has `workspaces` and a member
  package matching them lists it (npm and yarn hoist a member's Spindle to the
  root). A copy nothing declares, such as one another package brought along
  or one copied in by hand, is ignored:

  ```
  The project has Spindle 0.60.0 installed; spindle_play runs the story on Spindle 0.61.0, the copy spindle-lsp ships with.
  ```

The session runs on spindle-lsp's own copy either way.

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
`structuredContent`. Values are plain JSON:

- a `Map` becomes an object of its entries. Its keys become strings (an object
  key its JSON), so keys that read alike merge: `1` and `"1"` become one
  property with the later entry's value.
- a `Set` or typed array becomes an array.
- a `Date` becomes an ISO 8601 string (`"Invalid Date"` if it is invalid).
- a `bigint`, `NaN`, `Infinity`, a `RegExp` and an `Error` become strings
  (`"10"`, `"NaN"`, `"/a+/g"`, `"TypeError: message"`).
- as in JSON, a property whose value is `undefined` is left out, and an
  `undefined` array item becomes `null`.
- a reference cycle becomes the string `"[circular]"`.
- a value that cannot be cloned out of the worker (a function, say) comes back
  as `"[unserializable: <reason>]"`.

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
  `spindle_play_step`, the type, and a description. A link shows its label in
  JSON quotes (so a `"` or a line break in it is escaped) and `-> target`. An
  input shows `$variable = value`, with the value as JSON (`(unset)` when it
  has none) and, if it has any, `options: a, b, c`. A disabled action ends in
  `(disabled)`. With none, the section reads
  `Actions: none (ending or dead end)`.
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
| `spindle_play requires host-code trust: ...`                                      | `start` without host opt-in (see [host-code trust](#host-code-trust)) |
| `too many open play sessions (8); stop one with spindle_play_stop`                | `start` with 8 sessions open                            |
| `unknown or expired session <id>`                                                 | An id that was never issued, stopped, expired or closed |
| `spindle_play needs @rohal12/spindle <PLAY_SPINDLE_VERSION> or later`             | `start` when Spindle or its `spindle/play` is missing   |
| `play sessions are shutting down`                                                 | `start` while the server is closing                     |
| `spindle: play session timed out after <n> ms (the story may be stuck in a loop)` | A call exceeded the timeout; the session is closed      |
| `spindle: play session is closed`                                                 | A call queued behind a timeout                          |
| `spindle: no story files match <pattern>`                                         | `start` with a glob that matches nothing                |
| `file:line: message`, one per error                                               | `start` on Twee that does not compile                   |

In the no-match message, `<pattern>` is the glob resolved against the
server's working directory (an absolute path), not the text as given.

After a timeout the session id is forgotten, so the next call with it reports
`unknown or expired session <id>`. Messages that start with `spindle:` come
from `@rohal12/spindle/play` and are passed through as they are; so are the
story's own messages, such as an unknown action id.
