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
plugin needs Node.js 24 or later on `PATH` and nothing else installed:
`@rohal12/spindle`, which the play tools run stories on, comes with
`@rohal12/spindle-lsp` as a dependency.

## Install

```
/plugin marketplace add rohal12/spindle-lsp
/plugin install spindle-lsp@spindle
```

Restart Claude Code after installing.

To try a local checkout, add the repository path instead of
`rohal12/spindle-lsp`, or run `claude --plugin-dir ./plugins/spindle-lsp`.

## Play-testing while writing

Play execution is disabled by default. To enable it for trusted stories, set
`SPINDLE_LSP_TRUSTED_PLAY=1` in the MCP server environment and restart Claude
Code. Stories can read and write host files, read environment variables and run
commands with your account's privileges. This setting trusts every story run by
that server; see [host-code trust](../../docs/mcp-play-tools.md#host-code-trust).

Formatting uses JSON/YAML Prettier settings by default. Executable configs,
shareable config imports and plugins require the separate host setting
`SPINDLE_LSP_TRUSTED_FORMAT=1`; they run with your account's privileges. See
[formatter trust](../../docs/mcp-play-tools.md#host-code-trust) for details.

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
or a project directory. Twee is compiled and run by spindle-lsp's own
`@rohal12/spindle`, not the one installed in the project; if the project's
package.json (or, in a monorepo, a workspace member's) depends on a different
version, the result starts with a `Note:` saying so. A copy in `node_modules`
that no package.json declares is ignored. Each result lists the passage text,
the context, any open dialogs and macro errors, and the available actions with
the ids to pass to `spindle_play_step`. Up to 8 sessions can be open, a session
idle for 30 minutes is closed, and a call that takes more than 10 seconds
closes its session.

The play tools need a `@rohal12/spindle` with `@rohal12/spindle/play`, which
the plugin's `npx` install brings along. If it is missing, `spindle_play_start`
says so and the other tools are unaffected.

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
