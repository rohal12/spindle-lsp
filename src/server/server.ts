import {
  createConnection,
  ProposedFeatures,
  DidChangeWatchedFilesNotification,
  FileChangeType,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { glob } from 'glob';

import { WorkspaceModel } from '../core/workspace/workspace-model.js';
import { loadPlugins } from '../core/plugin/plugin-loader.js';
import { buildCapabilities } from './capabilities.js';
import { gateConnection } from './story-format-gate.js';
import { allPlugins } from '../plugins/index.js';
import type { SpindleConfig, SpindlePlugin } from '../core/plugin/plugin-api.js';
import type { StoryFormat } from '../core/workspace/story-format.js';
import { loadConfigFromDisk } from '../core/workspace/config-loader.js';
import { unsupportedVersionMessage } from '../core/workspace/spindle-version.js';
import {
  MACRO_SOURCE_GLOB,
  findMacroSourceFiles,
  isExcludedMacroSource,
  isMacroSource,
} from '../core/workspace/macro-sources.js';

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
 * Whether a URI names a project config file (matches the
 * `spindle.config.*` and `*twee-config.*` watcher globs).
 */
function isConfigFileUri(uri: string): boolean {
  const name = basename(uriToFsPath(uri));
  return name.startsWith('spindle.config.') || name.includes('twee-config.');
}

/**
 * Start the Spindle LSP server.
 *
 * Supports `--stdio` (default) and `--socket=<port>` transport modes.
 * Without a transport flag the server talks over stdin/stdout, which the
 * language-server library would otherwise refuse to guess.
 */
export function startServer(args: string[]): void {
  const hasTransport = args.some(arg => /^--(stdio|node-ipc|socket|pipe)(=|$)/.test(arg));
  const connection = hasTransport
    ? createConnection(ProposedFeatures.all)
    : createConnection(ProposedFeatures.all, process.stdin, process.stdout);
  const documents = new Map<string, TextDocument>();
  let workspace: WorkspaceModel;
  let activePlugins: SpindlePlugin[] = [];
  let workspaceRoot: string | undefined;
  let startupWarning: string | undefined;

  connection.onInitialize((params) => {
    console.error('[spindle-lsp] onInitialize called');
    const initOptions = (params.initializationOptions ?? {}) as Partial<SpindleConfig>;

    // Determine workspace root from LSP params (try multiple sources)
    workspaceRoot =
      initOptions.workspaceRoot ??
      (params.workspaceFolders?.[0]?.uri
        ? uriToFsPath(params.workspaceFolders[0].uri)
        : undefined) ??
      (params.rootUri ? uriToFsPath(params.rootUri) : undefined);

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
    workspace = new WorkspaceModel(workspaceRoot ? { workspaceRoot } : undefined);
    console.error('[spindle-lsp] workspaceRoot:', workspaceRoot ?? 'undefined');
    const target = workspace.capabilities;
    console.error('[spindle-lsp] target Spindle:', target.version ? `${target.version} (${target.source})` : 'not detected');
    if (!target.supported) {
      const message = unsupportedVersionMessage(target);
      console.error('[spindle-lsp] WARNING:', message);
      // Shown once the client is connected; diagnostics (SP001) repeat it per project
      startupWarning = `spindle-lsp: ${message}`;
    }

    // Load and filter plugins
    activePlugins = loadPlugins(allPlugins, config);
    console.error('[spindle-lsp] plugins loaded:', activePlugins.map(p => p.id).join(', '));

    // Spindle semantics apply only to Spindle projects: while StoryData
    // names another story format, every language feature request answers
    // null (diagnostics are emptied in computeDiagnostics).
    const model = workspace;
    const pluginConnection = gateConnection(connection, () => model.isSpindleProject());

    // Initialize each plugin with context
    for (const plugin of activePlugins) {
      plugin.initialize({ connection: pluginConnection, workspace, config });
    }

    const refresh = params.capabilities.workspace;
    let spindle = workspace.isSpindleProject();
    workspace.on('storyFormatChanged', (format: StoryFormat) => {
      // Log and refresh when the features switch on or off, not when only
      // the name of another format changes
      if (format.isSpindle === spindle) return;
      spindle = format.isSpindle;
      console.error(format.isSpindle
        ? '[spindle-lsp] story format is Spindle; language features enabled'
        : `[spindle-lsp] story format "${format.name}" is not Spindle; language features disabled`);
      // Ask the client to re-request what it caches for open documents
      // (diagnostics are republished by the diagnostics plugin)
      const requests = [
        refresh?.semanticTokens?.refreshSupport && 'workspace/semanticTokens/refresh',
        refresh?.inlayHint?.refreshSupport && 'workspace/inlayHint/refresh',
        refresh?.codeLens?.refreshSupport && 'workspace/codeLens/refresh',
      ];
      for (const method of requests) {
        if (method) connection.sendRequest(method).catch(() => { /* not answered */ });
      }
    });

    // Load user-defined macros from project config
    if (Object.keys(projectConfig.macros).length > 0) {
      workspace.macros.loadConfig(projectConfig.macros);
      console.error('[spindle-lsp] loaded config macros:', Object.keys(projectConfig.macros).length);
    }

    return {
      capabilities: buildCapabilities(activePlugins),
    };
  });

  connection.onInitialized(() => {
    if (startupWarning) void connection.window.showWarningMessage(startupWarning);
    // Register for file watching (fire-and-forget — don't block the connection)
    connection.client.register(DidChangeWatchedFilesNotification.type, {
      watchers: [
        { globPattern: '**/*.tw' },
        { globPattern: '**/*.twee' },
        { globPattern: MACRO_SOURCE_GLOB },
        { globPattern: '**/spindle.config.*' },
        { globPattern: '**/*twee-config.*' },
      ],
    }).catch(() => { /* client may not support dynamic registration */ });

    // Initial workspace scan — deferred so it doesn't block request processing
    if (workspace) {
      setImmediate(async () => {
        try {
          const fileContents = await scanWorkspaceFiles(workspaceRoot);
          console.error('[spindle-lsp] scanned', fileContents.size, 'files from root:', workspaceRoot ?? 'undefined');
          // Documents opened in the editor while the scan ran are
          // authoritative — don't replace their (possibly unsaved) text.
          for (const uri of documents.keys()) {
            fileContents.delete(uri);
          }
          workspace.initialize(fileContents);
          console.error('[spindle-lsp] workspace initialized, macros:', workspace.macros.getAllMacros().length);
        } catch (err) {
          console.error('[spindle-lsp] workspace scan failed:', err);
        }
      });
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
      // After the editor closes a tab the file may still exist on disk
      // (e.g. it was loaded during the workspace scan).  Re-read from disk
      // so its passages stay in the index; only truly remove if the file
      // is gone.
      try {
        const fsPath = uriToFsPath(textDocument.uri);
        const text = readFileSync(fsPath, 'utf-8');
        workspace.documents.update(textDocument.uri, text);
      } catch {
        // File no longer readable (deleted / outside workspace) — remove it
        workspace.documents.close(textDocument.uri);
      }
    }
  });

  // --- File watcher events ---

  /** Re-read the project config and replace the user macro overrides. */
  function reloadProjectConfig(): void {
    if (!workspaceRoot) return;
    try {
      const projectConfig = loadConfigFromDisk(workspaceRoot);
      workspace.macros.loadConfig(projectConfig.macros);
      console.error('[spindle-lsp] reloaded config macros:', Object.keys(projectConfig.macros).length);
    } catch (err) {
      // Keep the previous config (e.g. file saved mid-edit with a syntax error)
      console.error('[spindle-lsp] config reload failed:', err);
      return;
    }
    workspace.refresh();
  }

  connection.onDidChangeWatchedFiles(({ changes }) => {
    if (!workspace) return;

    let configChanged = false;
    for (const change of changes) {
      // Config files are not story documents — reload macro config instead
      if (isConfigFileUri(change.uri)) {
        configChanged = true;
        continue;
      }

      // Hidden, dependency and build-output JS is not a macro source
      // (same predicate as the initial scan)
      if (isMacroSource(change.uri)
        && isExcludedMacroSource(uriToFsPath(change.uri), workspaceRoot)) {
        continue;
      }

      // The editor owns open documents: ignore disk changes/deletions until
      // didClose, which re-reads the file from disk (or removes it).
      if (documents.has(change.uri)) continue;

      if (change.type === FileChangeType.Deleted) {
        workspace.documents.close(change.uri);
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

    if (configChanged) {
      reloadProjectConfig();
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
 * Scan workspace for .tw and .twee files, plus JS/TS macro sources, and
 * return their contents.
 */
async function scanWorkspaceFiles(
  root: string | undefined,
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  if (!root) return contents;

  try {
    const files = [
      ...await glob('**/*.{tw,twee}', {
        cwd: root,
        absolute: true,
        nodir: true,
      }),
      ...await findMacroSourceFiles(root),
    ];
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
