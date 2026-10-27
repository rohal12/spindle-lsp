# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability
reporting: [open a report](https://github.com/rohal12/spindle-lsp/security/advisories/new)
(the repository's Security tab, then "Report a vulnerability"). Please do not
open a public issue or pull request for a vulnerability.

A useful report says what an attacker can do, how to reproduce it (a story or
workspace, the editor or MCP client, the commands), and the affected version
(`npx @rohal12/spindle-lsp --version`).

The report stays private while it is investigated. A confirmed vulnerability
is fixed in a new release and published as a GitHub security advisory, with
credit to the reporter unless they ask otherwise.

## Supported versions

Fixes go into the next release of
[`@rohal12/spindle-lsp`](https://www.npmjs.com/package/@rohal12/spindle-lsp)
on npm. Older versions are not patched; update to the latest release.

## Scope

spindle-lsp is a language server, a command-line checker and formatter, and
an MCP server whose play tools run stories in happy-dom. All of them run
locally with the permissions of the user who starts them.

The parsing, diagnostics and story runtime come from Spindle. A vulnerability
in those belongs to [rohal12/spindle](https://github.com/rohal12/spindle);
report it there the same way, through
[its private vulnerability reporting](https://github.com/rohal12/spindle/security/advisories/new).
If you are not sure which repository is affected, report it here.
