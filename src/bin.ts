export {};

const args = process.argv.slice(2);

if (args[0] === 'check') {
  // CLI check mode — will be implemented in Phase 11
  console.error('spindle-lsp check: not yet implemented');
  process.exit(1);
} else if (args[0] === 'format') {
  // CLI format mode — will be implemented in Phase 11
  console.error('spindle-lsp format: not yet implemented');
  process.exit(1);
} else {
  // Default: start LSP server
  const { startServer } = await import('./server/server.js');
  startServer(args);
}
