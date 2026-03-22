export {};

const args = process.argv.slice(2);

if (args[0] === 'check') {
  const { runCheck } = await import('./cli/check.js');
  const exitCode = await runCheck(args.slice(1));
  process.exit(exitCode);
} else if (args[0] === 'format') {
  const { runFormat } = await import('./cli/format.js');
  const exitCode = await runFormat(args.slice(1));
  process.exit(exitCode);
} else {
  // Default: start LSP server
  const { startServer } = await import('./server/server.js');
  startServer(args);
}
