import type { ServerCapabilities, Connection } from 'vscode-languageserver';
import type { WorkspaceModel } from '../workspace/workspace-model.js';

/**
 * Interface that every Spindle feature plugin must implement.
 *
 * Each plugin declares its LSP capabilities and registers handlers
 * against the connection during `initialize`.
 */
export interface SpindlePlugin {
  /** Unique identifier used for filtering via disabledPlugins config. */
  id: string;

  /** LSP capabilities this plugin contributes. */
  capabilities: Partial<ServerCapabilities>;

  /** Called once during server initialization; register handlers here. */
  initialize(context: PluginContext): void;

  /** Optional cleanup when the server shuts down. */
  dispose?(): void;
}

/**
 * Context passed to each plugin during initialization.
 */
export interface PluginContext {
  connection: Connection;
  workspace: WorkspaceModel;
  config: SpindleConfig;
}

/**
 * Server-level configuration (from initializationOptions or settings).
 */
export interface SpindleConfig {
  /** Plugin IDs to skip loading. */
  disabledPlugins?: string[];

  /** Per-diagnostic-code enable/disable map. */
  diagnostics?: Record<string, boolean>;

  /** Workspace root URI or path. */
  workspaceRoot?: string;
}
