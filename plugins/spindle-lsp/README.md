# spindle-lsp for Claude Code

A Claude Code plugin that connects Claude to the Spindle language server.

- **LSP** (`.lsp.json`): Claude Code starts the server for `.tw` and `.twee`
  files. After each edit, Claude receives the file's diagnostics, and it can
  use go-to-definition, references and hover on passages, macros, widgets
  and variables.
- **MCP** (`.mcp.json`): the `spindle_check` and `spindle_format` tools check
  or format a whole project by glob, not just the files Claude has touched.

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

## Configuration

The server reads the project's `spindle.config.yaml` (or `.yml` or `.json`),
the same file `spindle-lsp check` uses.
