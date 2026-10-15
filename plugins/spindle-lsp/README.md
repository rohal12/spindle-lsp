# spindle-lsp for Claude Code

A Claude Code plugin that connects Claude to the Spindle language server.

- **LSP** (`.lsp.json`): Claude Code starts the server for `.tw` and `.twee`
  files. After each edit, Claude receives the file's diagnostics, and it can
  use go-to-definition, references and hover on passages, macros, widgets
  and variables.
- **MCP** (`.mcp.json`): the `spindle_check` and `spindle_format` tools check
  or format a whole project by glob, not just the files Claude has touched.
  The `spindle_play_*` tools play a story headlessly (see
  [Play-testing while writing](#play-testing-while-writing)).

Both run the latest `@rohal12/spindle-lsp` release through `npx`, so the
plugin needs Node.js 18 or later on `PATH` and nothing else installed.

## Install

```
/plugin marketplace add rohal12/spindle-lsp
/plugin install spindle-lsp@spindle
```

Restart Claude Code after installing.

To try a local checkout, add the repository path instead of
`rohal12/spindle-lsp`, or run `claude --plugin-dir ./plugins/spindle-lsp`.

## Play-testing while writing

Six MCP tools let Claude play the story it is editing, the way a reader would:

| Tool                   | Does                                     |
| ---------------------- | ---------------------------------------- |
| `spindle_play_start`   | Open a session; shows the first passage  |
| `spindle_play_observe` | Show the current passage again           |
| `spindle_play_step`    | Take an action, such as following a link |
| `spindle_play_goto`    | Jump to a passage                        |
| `spindle_play_vars`    | Read and/or set story variables          |
| `spindle_play_stop`    | Close a session                          |

`spindle_play_start` takes a compiled `.html`, a `.twee` or `.tw` file, a glob
or a project directory; Twee is compiled with the Spindle format installed in
the project. Each result lists the passage text, the context, any open dialogs
and macro errors, and the available actions with the ids to pass to
`spindle_play_step`. Up to 8 sessions can be open, a session idle for 30
minutes is closed, and a call that takes more than 10 seconds closes its
session.

The play tools need `@rohal12/spindle` with `@rohal12/spindle/play` (the first
release that has it). With an older Spindle, `spindle_play_start` says so and
the other tools are unaffected.

An example exchange, with Claude's calls on the left and the results shortened:

```
spindle_play_start { "story": "story/" }
  Session: 9d1d1bf2

  Passage: Start   (turn 1)

  The start. Hall

  Context:
  HP: 3

  Actions:
  1. link:Hall  link  "Hall" -> Hall

spindle_play_step { "session": "9d1d1bf2", "action": "link:Hall" }
  Passage: Hall   (turn 2)
  ...

spindle_play_vars { "session": "9d1d1bf2", "set": { "hp": 1 }, "get": ["hp"] }
  { "hp": 1 }

spindle_play_stop { "session": "9d1d1bf2" }
  stopped: 9d1d1bf2
```

Every tool's inputs, the result format, the limits and the error messages are
in [docs/mcp-play-tools.md](../../docs/mcp-play-tools.md).

## Configuration

The server reads the project's `spindle.config.yaml` (or `.yml` or `.json`),
the same file `spindle-lsp check` uses.
