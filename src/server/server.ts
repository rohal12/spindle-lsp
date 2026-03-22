import {
  createConnection,
  ProposedFeatures,
  DidChangeWatchedFilesNotification,
  FileChangeType,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { glob } from 'glob';

import { WorkspaceModel } from '../core/workspace/workspace-model.js';
import { loadPlugins } from '../core/plugin/plugin-loader.js';
import { buildCapabilities } from './capabilities.js';
import { allPlugins } from '../plugins/index.js';
import type { SpindleConfig, SpindlePlugin } from '../core/plugin/plugin-api.js';
import { loadConfigFromDisk } from '../core/workspace/config-loader.js';

/**
 * Convert a file:// URI to a filesystem path.
 * Returns the original string if it is not a file URI.
 */
function uriToFsPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

/**
 * Convert a filesystem path to a file:// URI string.
 */
function fsPathToUri(fsPath: string): string {
  return pathToFileURL(fsPath).toString();
}

/**
 * Start the Spindle LSP server.
 *
 * Supports `--stdio` (default) and `--socket=<port>` transport modes.
 */
export function startServer(_args: string[]): void {
  const connection = createConnection(ProposedFeatures.all);
  const documents = new Map<string, TextDocument>();
  let workspace: WorkspaceModel;
  let activePlugins: SpindlePlugin[] = [];
  let workspaceRoot: string | undefined;

  connection.onInitialize((params) => {
    console.error('[spindle-lsp] onInitialize called');
    const initOptions = (params.initializationOptions ?? {}) as Partial<SpindleConfig>;

    // Determine workspace root from LSP params
    workspaceRoot =
      initOptions.workspaceRoot ??
      (params.workspaceFolders?.[0]?.uri
        ? uriToFsPath(params.workspaceFolders[0].uri)
        : undefined);

    // Load project config from disk if we have a workspace root
    const projectConfig = workspaceRoot
      ? loadConfigFromDisk(workspaceRoot)
      : { macros: {} };

    const config: SpindleConfig = {
      disabledPlugins: initOptions.disabledPlugins,
      diagnostics: initOptions.diagnostics,
      workspaceRoot,
    };

    // Create workspace model
    workspace = new WorkspaceModel();
    console.error('[spindle-lsp] workspaceRoot:', workspaceRoot ?? 'undefined');

    // Load and filter plugins
    activePlugins = loadPlugins(allPlugins, config);
    console.error('[spindle-lsp] plugins loaded:', activePlugins.map(p => p.id).join(', '));

    // Initialize each plugin with context
    for (const plugin of activePlugins) {
      plugin.initialize({ connection, workspace, config });
    }

    // Load user-defined macros from project config
    if (Object.keys(projectConfig.macros).length > 0) {
      workspace.macros.loadSupplements(projectConfig.macros);
      console.error('[spindle-lsp] loaded config macros:', Object.keys(projectConfig.macros).length);
    }

    return {
      capabilities: buildCapabilities(activePlugins),
    };
  });

  connection.onInitialized(async () => {
    // Register for file watching
    connection.client.register(DidChangeWatchedFilesNotification.type, {
      watchers: [
        { globPattern: '**/*.tw' },
        { globPattern: '**/*.twee' },
        { globPattern: '**/*.js' },
        { globPattern: '**/*.ts' },
        { globPattern: '**/spindle.config.*' },
        { globPattern: '**/*twee-config.*' },
      ],
    });

    // Initial workspace scan
    if (workspace) {
      const fileContents = await scanWorkspaceFiles(workspaceRoot);
      console.error('[spindle-lsp] onInitialized: scanned', fileContents.size, 'files from root:', workspaceRoot ?? 'undefined');
      workspace.initialize(fileContents);
      console.error('[spindle-lsp] workspace initialized, macros:', workspace.macros.getAllMacros().length, 'warnings:', workspace.macros.warnings);
    }
  });

  // --- Document synchronization ---

  connection.onDidOpenTextDocument(({ textDocument }) => {
    const doc = TextDocument.create(
      textDocument.uri,
      textDocument.languageId,
      textDocument.version,
      textDocument.text,
    );
    documents.set(textDocument.uri, doc);
    if (workspace) {
      workspace.documents.open(textDocument.uri, textDocument.text);
    }
  });

  connection.onDidChangeTextDocument(({ textDocument, contentChanges }) => {
    const existing = documents.get(textDocument.uri);
    if (existing) {
      const updated = TextDocument.update(
        existing,
        contentChanges,
        textDocument.version,
      );
      documents.set(textDocument.uri, updated);
      if (workspace) {
        workspace.documents.update(textDocument.uri, updated.getText());
      }
    }
  });

  connection.onDidCloseTextDocument(({ textDocument }) => {
    documents.delete(textDocument.uri);
    if (workspace) {
      workspace.documents.close(textDocument.uri);
    }
  });

  // --- File watcher events ---

  connection.onDidChangeWatchedFiles(({ changes }) => {
    if (!workspace) return;

    for (const change of changes) {
      if (change.type === FileChangeType.Deleted) {
        workspace.documents.close(change.uri);
        documents.delete(change.uri);
      } else {
        // Created or Changed — re-read from disk
        try {
          const fsPath = uriToFsPath(change.uri);
          const text = readFileSync(fsPath, 'utf-8');
          if (workspace.documents.has(change.uri)) {
            workspace.documents.update(change.uri, text);
          } else {
            workspace.documents.open(change.uri, text);
          }
        } catch {
          // File may have been deleted between event and read
        }
      }
    }
  });

  // --- Lifecycle ---

  connection.onShutdown(() => {
    for (const plugin of activePlugins) {
      plugin.dispose?.();
    }
    workspace?.dispose();
  });

  connection.listen();
}

/**
 * Scan workspace for .tw and .twee files and return their contents.
 */
async function scanWorkspaceFiles(
  root: string | undefined,
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  if (!root) return contents;

  try {
    const files = await glob('**/*.{tw,twee}', {
      cwd: root,
      absolute: true,
      nodir: true,
    });
    for (const filePath of files) {
      try {
        const text = readFileSync(filePath, 'utf-8');
        const uri = fsPathToUri(filePath);
        contents.set(uri, text);
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Glob failure — return empty
  }

  return contents;
}
