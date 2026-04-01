export {};

declare const SPINDLE_LSP_VERSION: string;

const args = process.argv.slice(2);

const VERSION = SPINDLE_LSP_VERSION;

const HELP = `\
spindle-lsp v${VERSION}
Language Server Protocol server for Spindle story format

Usage:
  spindle-lsp                Start the LSP server (stdio)
  spindle-lsp check <files>  Lint .twee/.tw files
  spindle-lsp format <files> Format .twee/.tw files in place
  spindle-lsp mcp            Start the MCP server

Options:
  --help, -h                 Show this help message
  --version, -v              Show version number

Check options:
  --format <pretty|json|sarif>   Output format (default: pretty)
  --severity <level>             Minimum severity: error, warning, info, hint
  --config <path>                Path to config file
  --max-line-length <n>          Warn on lines exceeding n characters`;

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(HELP);
  process.exit(0);
} else if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION);
  process.exit(0);
} else if (args[0] === 'check') {
  const { runCheck } = await import('./cli/check.js');
  const exitCode = await runCheck(args.slice(1));
  process.exit(exitCode);
} else if (args[0] === 'format') {
  const { runFormat } = await import('./cli/format.js');
  const exitCode = await runFormat(args.slice(1));
  process.exit(exitCode);
} else if (args[0] === 'mcp') {
  const { startMcpServer } = await import('./mcp/server.js');
  await startMcpServer();
} else {
  // Default: start LSP server
  const { startServer } = await import('./server/server.js');
  startServer(args);
}
